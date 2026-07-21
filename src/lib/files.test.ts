import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { doc, newDoc, edit, isDirty, openDoc } from './doc'
import { open, save, saveAs, openPath, openInPreferredTarget } from './files'
import { errorMessage } from './errors'
import { openList } from './openList'
import { settings, DEFAULTS } from './settings'

beforeEach(() => {
  invoke.mockReset()
  newDoc()
  openList.set([])
  settings.set({ ...DEFAULTS }) // openMode: 'tab' (MODE A) unless a test opts in
})

describe('openPath', () => {
  it('loads the given path into the store without a dialog', async () => {
    invoke.mockResolvedValue('# From association')
    await openPath('/tmp/assoc.md')
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/tmp/assoc.md' })
    const s = get(doc)
    expect(s.path).toBe('/tmp/assoc.md')
    expect(s.content).toBe('# From association')
    expect(isDirty(s)).toBe(false)
  })

  it('reports an error when the read fails', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('nope')
    await openPath('/tmp/missing.md')
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('adds the path to the open list on success', async () => {
    invoke.mockResolvedValue('# From association')
    await openPath('/tmp/assoc.md')
    expect(get(openList)).toEqual(['/tmp/assoc.md'])
  })

  it('re-opening an already-listed path does not duplicate it', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/a.md')
    await openPath('/tmp/a.md')
    expect(get(openList)).toEqual(['/tmp/a.md'])
  })

  it('leaves the open list untouched when the read fails', async () => {
    invoke.mockRejectedValue('nope')
    await openPath('/tmp/missing.md')
    expect(get(openList)).toEqual([])
  })
})

describe('open', () => {
  it('loads the file picked via the Rust dialog into the store', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(invoke).toHaveBeenCalledWith('open_file_dialog')
    const s = get(doc)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# Loaded')
    expect(isDirty(s)).toBe(false)
  })

  it('does nothing when the dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    await open()
    expect(get(doc).path).toBeNull()
  })

  it('adds the picked path to the open list', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(get(openList)).toEqual(['/tmp/a.md'])
  })

  it('leaves the open list untouched when the dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    await open()
    expect(get(openList)).toEqual([])
  })
})

describe('save', () => {
  it('writes to the existing path and records the saved content', async () => {
    // arrange a document already backed by a path, with unsaved edits
    doc.set({ path: '/tmp/a.md', content: 'body', savedContent: 'old', readonly: false, loadId: 1 })
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/a.md', contents: 'body' })
    expect(isDirty(get(doc))).toBe(false)
  })

  it('falls back to Save As when there is no path', async () => {
    newDoc()
    edit('draft')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/new.md' : undefined,
    )
    await save()
    expect(invoke).toHaveBeenCalledWith('save_file_dialog', { defaultPath: 'untitled.md' })
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/new.md', contents: 'draft' })
    expect(get(doc).path).toBe('/tmp/new.md')
    expect(isDirty(get(doc))).toBe(false)
  })

  it('keeps edits typed during an in-flight save dirty', async () => {
    doc.set({ path: '/tmp/a.md', content: 'v1', savedContent: 'v0', readonly: false, loadId: 1 })
    invoke.mockImplementation(async () => {
      edit('v2') // the user types while write_file is in flight
    })
    await save()
    const s = get(doc)
    expect(s.content).toBe('v2')
    expect(s.savedContent).toBe('v1') // what actually hit disk
    expect(isDirty(s)).toBe(true)
  })
})

describe('saveAs', () => {
  it('does nothing when the save dialog is cancelled', async () => {
    newDoc()
    edit('draft')
    invoke.mockResolvedValue(null)
    await saveAs()
    expect(invoke).toHaveBeenCalledTimes(1) // only the dialog, no write_file
    expect(isDirty(get(doc))).toBe(true)
  })

  it('reports an error when the dialog itself fails', async () => {
    errorMessage.set(null)
    newDoc()
    edit('draft')
    invoke.mockRejectedValue('no display server')
    await saveAs()
    expect(get(errorMessage)).toContain('Could not save file')
  })

  it('adds the newly saved-as path to the open list', async () => {
    newDoc()
    edit('draft')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/new.md' : undefined,
    )
    await saveAs()
    expect(get(openList)).toEqual(['/tmp/new.md'])
  })
})

describe('openInPreferredTarget', () => {
  it("MODE A ('tab'): delegates to the caller-supplied in-place opener", () => {
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    expect(opened).toEqual(['/tmp/a.md'])
    expect(invoke).not.toHaveBeenCalledWith('open_document_window', expect.anything())
  })

  it("MODE B ('window'): spawns a new window and does NOT open in place", () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockResolvedValue(undefined)
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    expect(invoke).toHaveBeenCalledWith('open_document_window', { path: '/tmp/a.md' })
    expect(opened).toEqual([]) // focused window keeps its own doc
  })

  it("MODE B: falls back to opening in place if spawning the window fails", async () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    errorMessage.set(null)
    invoke.mockRejectedValue('no window config to clone')
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    await vi.waitFor(() => expect(opened).toEqual(['/tmp/a.md']))
    expect(get(errorMessage)).toContain('Could not open a new window')
  })

  it("MODE B: File > Open routes the picked file to a new window", async () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(invoke).toHaveBeenCalledWith('open_document_window', { path: '/tmp/a.md' })
    // The focused window's own doc is untouched (the new window loads it).
    expect(get(doc).path).toBeNull()
    expect(get(openList)).toEqual([])
  })
})

describe('error handling', () => {
  it('reports an error when read_file rejects', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('boom')
    await openPath('/tmp/a.md')
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('reports an error when write_file rejects and keeps dirty', async () => {
    errorMessage.set(null)
    doc.set({ path: '/tmp/a.md', content: 'body', savedContent: 'old', readonly: false, loadId: 1 })
    invoke.mockRejectedValue('disk full')
    await save()
    expect(get(errorMessage)).toContain('Could not save file')
    expect(isDirty(get(doc))).toBe(true)
  })
})

describe('readonly', () => {
  it('openPath threads the readonly flag into the store', async () => {
    invoke.mockResolvedValue('# RO')
    await openPath('/tmp/ro.md', true)
    expect(get(doc).readonly).toBe(true)
  })

  it('openPath defaults to editable', async () => {
    invoke.mockResolvedValue('# RW')
    await openPath('/tmp/rw.md')
    expect(get(doc).readonly).toBe(false)
  })

  it('save is a no-op while readonly', async () => {
    openDoc('/tmp/ro.md', 'body', true)
    await save()
    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })

  it('saveAs from a readonly doc retargets to the copy and enables editing', async () => {
    openDoc('/tmp/ro.md', 'body', true)
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/copy.md' : undefined,
    )
    await saveAs()
    const s = get(doc)
    expect(s.path).toBe('/tmp/copy.md')
    expect(s.readonly).toBe(false)
    expect(isDirty(s)).toBe(false)
  })
})
