import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { invoke } from './test-support/tauriMocks'

// Capture listen() registrations so tests can dispatch events and observe
// unlistens (the fileSync.test.ts pattern, extended with a registry).
type EventPayload = { payload: { target?: string | null } | null }
type Handler = (e: EventPayload) => void
const listeners = new Map<string, Handler[]>()
const unlistened: string[] = []
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
    return () => {
      unlistened.push(event)
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((h) => h !== handler),
      )
    }
  }),
}))

// Keep the real listenScoped (wireEvents goes through it, exercising the
// target filter) but spy setWindowTitle for initWindowTitleSync.
vi.mock('./windowing', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./windowing')>()
  return { ...mod, setWindowTitle: vi.fn() }
})

import { setWindowTitle } from './windowing'
import {
  wireEvents,
  drainOpenedFiles,
  drainStartupFiles,
  closeTabDecision,
  initReadonlyMenuSync,
  initExportOnTick,
  initWindowTitleSync,
  bootApp,
} from './appBoot'
import { doc, docWith, resetReadonlyMemory } from './doc'
import { openList, previewPath } from './openList'
import { errorMessage } from './errors'
import { requestExport } from './ui'

function emit(event: string, payload: { target?: string | null } | null = null): void {
  for (const h of [...(listeners.get(event) ?? [])]) h({ payload })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const invokedCommands = () => invoke.mock.calls.map(([cmd]) => cmd as string)

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  listeners.clear()
  unlistened.length = 0
  vi.mocked(setWindowTitle).mockClear()
  resetReadonlyMemory()
  doc.set(docWith())
  openList.set([])
  previewPath.set(null)
  errorMessage.set(null)
})

describe('wireEvents', () => {
  it('registers every map entry and dispatches deliveries to the mapped handler', async () => {
    const onNew = vi.fn()
    const onOpen = vi.fn()
    wireEvents({ 'menu:new': onNew, 'menu:open': onOpen })
    await flush()
    expect(listeners.get('menu:new')).toHaveLength(1)
    expect(listeners.get('menu:open')).toHaveLength(1)
    emit('menu:new')
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('drops payloads targeted at another window, keeps own-label and broadcasts', async () => {
    const onNew = vi.fn()
    wireEvents({ 'menu:new': onNew })
    await flush()
    emit('menu:new', { target: 'doc-2' }) // this window's label is 'main' (tauriMocks)
    expect(onNew).not.toHaveBeenCalled()
    emit('menu:new', { target: 'main' })
    emit('menu:new', null) // broadcast
    expect(onNew).toHaveBeenCalledTimes(2)
  })

  it('teardown unlistens everything once the registrations resolve', async () => {
    const onNew = vi.fn()
    const teardown = wireEvents({ 'menu:new': onNew, 'menu:open': vi.fn() })
    await flush()
    teardown()
    await flush()
    expect(unlistened).toEqual(expect.arrayContaining(['menu:new', 'menu:open']))
    emit('menu:new')
    expect(onNew).not.toHaveBeenCalled()
  })
})

describe('drainStartupFiles', () => {
  it('opens the assigned file and never touches the global queue', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_window_file') return { path: '/w/assigned.md', readonly: true }
      if (cmd === 'read_file') return '# assigned'
      return undefined
    })
    const openFirst = vi.fn()
    await drainStartupFiles(openFirst)
    await flush() // openPath's read is fire-and-forget inside takeAssignedFile
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/w/assigned.md' })
    expect(invokedCommands()).not.toContain('take_opened_files')
    expect(openFirst).not.toHaveBeenCalled()
    expect(get(doc).path).toBe('/w/assigned.md')
    expect(get(doc).readonly).toBe(true)
  })

  it('with no assignment, drains the global queue: first entry via openFirst, rest pinned', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_window_file') return null
      if (cmd === 'take_opened_files')
        return [
          { path: '/w/first.md', readonly: false },
          { path: '/w/second.md', readonly: true },
        ]
      return undefined
    })
    const openFirst = vi.fn()
    await drainStartupFiles(openFirst)
    expect(openFirst).toHaveBeenCalledTimes(1)
    expect(openFirst).toHaveBeenCalledWith('/w/first.md', false)
    expect(get(openList)).toContain('/w/second.md') // surfaced without stealing activation
  })

  it('surfaces an assignment-drain failure and still falls back to the global drain', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_window_file') throw new Error('ipc down')
      if (cmd === 'take_opened_files') return []
      return undefined
    })
    await drainStartupFiles(vi.fn())
    expect(get(errorMessage)).toMatch('Could not open the file assigned to this window')
    expect(invokedCommands()).toContain('take_opened_files')
  })

  it('treats an empty drained batch as a no-op', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_window_file') return null
      if (cmd === 'take_opened_files') return []
      return undefined
    })
    const openFirst = vi.fn()
    await drainStartupFiles(openFirst)
    expect(openFirst).not.toHaveBeenCalled()
    expect(get(openList)).toEqual([])
    expect(get(errorMessage)).toBeNull()
  })
})

describe('closeTabDecision', () => {
  it('closes the active file when the doc has a path', () => {
    expect(closeTabDecision('/w/a.md', '/w/pv.md', ['/w/b.md'])).toEqual({
      kind: 'close-file',
      path: '/w/a.md',
    })
  })

  it('on an untitled doc, lands back on the preview first', () => {
    expect(closeTabDecision(null, '/w/pv.md', ['/w/b.md'])).toEqual({
      kind: 'reopen-preview',
      path: '/w/pv.md',
    })
  })

  it('with no preview, lands on the LAST pinned entry', () => {
    expect(closeTabDecision(null, null, ['/w/a.md', '/w/b.md'])).toEqual({
      kind: 'reopen-pinned',
      path: '/w/b.md',
    })
  })

  it('with nothing else open, falls through to closing the window', () => {
    expect(closeTabDecision(null, null, [])).toEqual({ kind: 'close-window' })
  })
})

describe('initReadonlyMenuSync', () => {
  const menuCalls = () =>
    invoke.mock.calls.filter(([cmd]) => cmd === 'set_readonly_menu_state')

  it('seeds on subscribe, re-syncs only on readonly flips, stops on unsubscribe', () => {
    const unsub = initReadonlyMenuSync()
    expect(menuCalls()).toEqual([['set_readonly_menu_state', { checked: false }]])
    doc.set(docWith({ content: 'typed', savedContent: 'typed' })) // content-only update
    expect(menuCalls()).toHaveLength(1)
    doc.set(docWith({ readonly: true }))
    expect(menuCalls()).toHaveLength(2)
    expect(menuCalls()[1]).toEqual(['set_readonly_menu_state', { checked: true }])
    unsub()
    doc.set(docWith({ readonly: false }))
    expect(menuCalls()).toHaveLength(2)
  })
})

describe('initExportOnTick', () => {
  it('skips the subscribe replay, exports once per tick, stops on teardown', () => {
    const onExport = vi.fn()
    const teardown = initExportOnTick(onExport)
    expect(onExport).not.toHaveBeenCalled() // mount replay skipped
    requestExport()
    expect(onExport).toHaveBeenCalledTimes(1)
    teardown()
    requestExport()
    expect(onExport).toHaveBeenCalledTimes(1)
  })
})

describe('initWindowTitleSync', () => {
  it('fires on subscribe, gates on the computed title changing, tracks dirty flips', () => {
    doc.set(docWith({ path: '/w/notes.md' }))
    const teardown = initWindowTitleSync()
    expect(setWindowTitle).toHaveBeenCalledTimes(1)
    expect(setWindowTitle).toHaveBeenCalledWith('notes.md — Markdon')
    doc.set(docWith({ path: '/w/notes.md' })) // same title: no IPC
    expect(setWindowTitle).toHaveBeenCalledTimes(1)
    doc.set(docWith({ path: '/w/notes.md', content: 'dirty' }))
    expect(setWindowTitle).toHaveBeenCalledTimes(2)
    expect(setWindowTitle).toHaveBeenLastCalledWith('• notes.md — Markdon')
    teardown()
    doc.set(docWith({ path: '/w/other.md' }))
    expect(setWindowTitle).toHaveBeenCalledTimes(2)
  })
})

describe('bootApp', () => {
  it('wires events, drains startup files, and its teardown unlistens everything', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_window_file') return null
      if (cmd === 'take_opened_files') return []
      if (cmd === 'take_startup_workspace') return { workspace: null, suppress_restore: true }
      return undefined
    })
    const onNew = vi.fn()
    const teardown = bootApp({
      menuEvents: { 'menu:new': onNew },
      openStartupFile: vi.fn(),
    })
    await flush()
    emit('menu:new')
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(invokedCommands()).toContain('take_window_file')
    expect(invokedCommands()).toContain('take_opened_files')
    teardown()
    await flush()
    expect(unlistened).toContain('menu:new')
    emit('menu:new')
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
