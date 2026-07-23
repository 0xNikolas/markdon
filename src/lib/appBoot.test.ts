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
  openLastFileOrScratch,
  maybeRestoreBootDocument,
  bootApp,
} from './appBoot'
import { doc, docWith, openDoc, resetReadonlyMemory, showEmptyState } from './doc'
import { openList, previewPath } from './openList'
import { errorMessage } from './errors'
import { emptyState, imageView, requestExport } from './ui'
import { workspace } from './workspace'
import { tree } from './test-support/workspaceFixtures'

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
  workspace.set({ root: null, tree: null })
  emptyState.set(false)
  imageView.set(null)
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
    expect(await drainStartupFiles(openFirst)).toBe(true) // window claimed
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
    expect(await drainStartupFiles(openFirst)).toBe(true) // window claimed
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
    expect(await drainStartupFiles(openFirst)).toBe(false) // truly unclaimed
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

  it('with no preview, lands on the FIRST (most recent, top) pinned entry', () => {
    expect(closeTabDecision(null, null, ['/w/a.md', '/w/b.md'])).toEqual({
      kind: 'reopen-pinned',
      path: '/w/a.md',
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

  it('drops ticks while the empty page is shown (Header button stays clickable)', () => {
    const onExport = vi.fn()
    const teardown = initExportOnTick(onExport)
    showEmptyState()
    requestExport()
    expect(onExport).not.toHaveBeenCalled()
    openDoc('/w/a.md', '# a') // any document load re-arms exporting
    requestExport()
    expect(onExport).toHaveBeenCalledTimes(1)
    teardown()
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

  it('renders plain "Markdon" while the empty page is shown, restoring on load', () => {
    const teardown = initWindowTitleSync()
    expect(setWindowTitle).toHaveBeenLastCalledWith('Untitled — Markdon')
    showEmptyState()
    expect(setWindowTitle).toHaveBeenLastCalledWith('Markdon')
    openDoc('/w/notes.md', '# n')
    expect(setWindowTitle).toHaveBeenLastCalledWith('notes.md — Markdon')
    teardown()
  })

  it('titles by the viewed image filename (never dirty), reverting when the view closes', () => {
    doc.set(docWith({ path: '/w/notes.md', content: 'dirty', savedContent: 'clean' }))
    const teardown = initWindowTitleSync()
    expect(setWindowTitle).toHaveBeenLastCalledWith('• notes.md — Markdon')
    imageView.set('/ws/photo.png')
    expect(setWindowTitle).toHaveBeenLastCalledWith('photo.png — Markdon') // image wins, no bullet
    imageView.set(null) // opening a doc clears it; title reverts to the doc underneath
    expect(setWindowTitle).toHaveBeenLastCalledWith('• notes.md — Markdon')
    teardown()
    imageView.set('/ws/other.png')
    expect(setWindowTitle).toHaveBeenLastCalledWith('• notes.md — Markdon') // unsubscribed
  })
})

describe('maybeRestoreBootDocument', () => {
  const seedWorkspaceStore = () => workspace.set({ root: '/ws', tree })
  /** load_workspace_ui resolves `last`; everything else keeps the default. */
  const uiMock = (last: string | null) =>
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'load_workspace_ui' ? last : undefined,
    )

  it('opens the remembered last file of an unclaimed workspace window', async () => {
    seedWorkspaceStore()
    uiMock('/ws/docs/note.md')
    const openFile = vi.fn()
    const openScratch = vi.fn()
    await maybeRestoreBootDocument(openFile, openScratch)
    expect(invoke).toHaveBeenCalledWith('load_workspace_ui', { root: '/ws' })
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(openFile).toHaveBeenCalledWith('/ws/docs/note.md')
    expect(openScratch).not.toHaveBeenCalled()
    expect(get(emptyState)).toBe(false) // a workspace boot never shows the empty page
  })

  it('opens a fresh scratch when the workspace remembers no (valid) last file', async () => {
    seedWorkspaceStore()
    uiMock(null)
    const openFile = vi.fn()
    const openScratch = vi.fn()
    await maybeRestoreBootDocument(openFile, openScratch)
    expect(openFile).not.toHaveBeenCalled()
    expect(openScratch).toHaveBeenCalledTimes(1)
    expect(get(emptyState)).toBe(false) // scratch, NOT the empty page
  })

  it('degrades a load_workspace_ui failure to the scratch (never a banner)', async () => {
    seedWorkspaceStore()
    invoke.mockRejectedValue('ipc down')
    const openScratch = vi.fn()
    await maybeRestoreBootDocument(vi.fn(), openScratch)
    expect(openScratch).toHaveBeenCalledTimes(1)
    expect(get(errorMessage)).toBeNull()
  })

  it.each([
    ['the doc already has a path', () => { seedWorkspaceStore(); doc.set(docWith({ path: '/w/a.md' })) }],
    ['the untitled scratch holds content', () => { seedWorkspaceStore(); doc.set(docWith({ content: 'typed' })) }],
    ['a file is already pinned open', () => { seedWorkspaceStore(); openList.set(['/w/a.md']) }],
    ['a preview is already active', () => { seedWorkspaceStore(); previewPath.set('/w/a.md') }],
  ])('a claimed window restores nothing and never shows the empty page when %s', async (_label, arrange) => {
    arrange()
    uiMock('/ws/docs/note.md')
    const openFile = vi.fn()
    const openScratch = vi.fn()
    await maybeRestoreBootDocument(openFile, openScratch)
    expect(openFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
    expect(get(emptyState)).toBe(false)
  })

  it('an unclaimed window with no workspace at all shows the empty page', async () => {
    const openFile = vi.fn()
    const openScratch = vi.fn()
    await maybeRestoreBootDocument(openFile, openScratch)
    expect(openFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
    expect(get(emptyState)).toBe(true)
    // showEmptyState also reset the buffer to a pristine scratch.
    expect(get(doc).path).toBeNull()
    expect(get(doc).content).toBe('')
    expect(invoke).not.toHaveBeenCalledWith('load_workspace_ui', expect.anything())
  })

  it('an open landing while the last-file lookup is in flight wins over the restore', async () => {
    seedWorkspaceStore()
    let resolveLoad!: (v: unknown) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'load_workspace_ui'
        ? new Promise((r) => {
            resolveLoad = r
          })
        : Promise.resolve(undefined),
    )
    const openFile = vi.fn()
    const openScratch = vi.fn()
    const p = maybeRestoreBootDocument(openFile, openScratch)
    doc.set(docWith({ path: '/w/raced.md' })) // e.g. a startup drain's open landing late
    resolveLoad('/ws/docs/note.md')
    await p
    expect(openFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
  })
})

describe('openLastFileOrScratch', () => {
  it('drops a lookup that resolves after the root changed (stale transition)', async () => {
    workspace.set({ root: '/ws', tree })
    let resolveLoad!: (v: unknown) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'load_workspace_ui'
        ? new Promise((r) => {
            resolveLoad = r
          })
        : Promise.resolve(undefined),
    )
    const openFile = vi.fn()
    const openScratch = vi.fn()
    const p = openLastFileOrScratch('/ws', openFile, openScratch)
    workspace.set({ root: null, tree: null }) // Close Folder raced the lookup
    resolveLoad('/ws/docs/note.md')
    await p
    expect(openFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
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
      openRestoredFile: vi.fn(),
      openScratch: vi.fn(),
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

  /** Boot-time IPC table for the last-file restore tests; overrides win per-command. */
  const bootMock = (overrides: Record<string, unknown> = {}) =>
    invoke.mockImplementation(async (cmd: unknown) => {
      if ((cmd as string) in overrides) return overrides[cmd as string]
      if (cmd === 'take_window_file') return null
      if (cmd === 'take_opened_files') return []
      if (cmd === 'take_startup_workspace') return { workspace: null, suppress_restore: false }
      if (cmd === 'restore_workspace') return { root: '/ws', tree }
      if (cmd === 'load_workspace_ui') return null
      if (cmd === 'read_file') return '# stub'
      return undefined
    })

  const boot = (opts: { openRestoredFile?: ReturnType<typeof vi.fn>; openScratch?: ReturnType<typeof vi.fn> } = {}) =>
    bootApp({
      menuEvents: {},
      openStartupFile: vi.fn(),
      openRestoredFile: opts.openRestoredFile ?? vi.fn(),
      openScratch: opts.openScratch ?? vi.fn(),
    })

  it('an unclaimed window with a restored workspace opens its remembered last file', async () => {
    bootMock({ load_workspace_ui: '/ws/docs/note.md' })
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    expect(invoke).toHaveBeenCalledWith('load_workspace_ui', { root: '/ws' })
    expect(openRestoredFile).toHaveBeenCalledTimes(1)
    expect(openRestoredFile).toHaveBeenCalledWith('/ws/docs/note.md')
    expect(openScratch).not.toHaveBeenCalled()
    teardown()
  })

  it('a fresh workspace (no remembered file) boots to the scratch, not the empty page', async () => {
    bootMock() // load_workspace_ui: null
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    expect(openScratch).toHaveBeenCalledTimes(1)
    expect(openRestoredFile).not.toHaveBeenCalled()
    expect(get(emptyState)).toBe(false)
    teardown()
  })

  it('a window-assigned file suppresses the last-file restore (assignment wins)', async () => {
    bootMock({
      take_window_file: { path: '/w/assigned.md', readonly: false },
      load_workspace_ui: '/ws/docs/note.md',
    })
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    expect(openRestoredFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
    teardown()
  })

  it('drained startup files suppress the restore even before their opens land', async () => {
    // openStartupFile is a spy that opens nothing, so the doc is STILL a clean
    // scratch when the workspace settles — only the drained-entries guard can
    // suppress here, which is exactly what this pins.
    bootMock({
      take_opened_files: [{ path: '/w/first.md', readonly: false }],
      load_workspace_ui: '/ws/docs/note.md',
    })
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    expect(openRestoredFile).not.toHaveBeenCalled()
    expect(openScratch).not.toHaveBeenCalled()
    teardown()
  })

  it('a root adopted AFTER boot opens that workspace\'s last file (mid-session restore)', async () => {
    bootMock({ restore_workspace: null }) // cold launch, nothing to restore
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    // Nothing to restore and nothing handed off: the boot settles on the
    // no-document empty page …
    expect(get(emptyState)).toBe(true)
    expect(openRestoredFile).not.toHaveBeenCalled()
    // … and a folder adopted mid-session (dialog / Open Recent / empty-page
    // recent row) restores ITS last-open file through the same rule.
    bootMock({ load_workspace_ui: '/ws/docs/note.md' })
    workspace.set({ root: '/ws', tree })
    await flush()
    expect(openRestoredFile).toHaveBeenCalledTimes(1)
    expect(openRestoredFile).toHaveBeenCalledWith('/ws/docs/note.md')
    // A refresh re-adopting the SAME root is not a transition: nothing more fires.
    workspace.set({ root: '/ws', tree })
    await flush()
    expect(openRestoredFile).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('a mid-session adopt with no remembered file lands on the scratch', async () => {
    bootMock({ restore_workspace: null })
    const openScratch = vi.fn()
    const teardown = boot({ openScratch })
    await flush()
    workspace.set({ root: '/ws', tree })
    await flush()
    expect(openScratch).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('Close Folder (root -> null) leaves the document alone', async () => {
    bootMock()
    const openRestoredFile = vi.fn()
    const openScratch = vi.fn()
    const teardown = boot({ openRestoredFile, openScratch })
    await flush()
    expect(openScratch).toHaveBeenCalledTimes(1) // the boot restore itself
    workspace.set({ root: null, tree: null })
    await flush()
    expect(openScratch).toHaveBeenCalledTimes(1) // no further restore fired
    expect(openRestoredFile).not.toHaveBeenCalled()
    expect(get(emptyState)).toBe(false) // and never the empty page mid-session
    teardown()
  })

  it('a startup-claimed window never shows the empty page even with no workspace', async () => {
    bootMock({
      restore_workspace: null,
      take_opened_files: [{ path: '/w/first.md', readonly: false }],
    })
    const teardown = boot()
    await flush()
    expect(get(emptyState)).toBe(false)
    teardown()
  })
})
