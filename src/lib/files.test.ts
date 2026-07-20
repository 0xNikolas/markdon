import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { doc, newDoc, edit, isDirty } from './doc'
import { open, save, saveAs, openPath } from './files'
import { errorMessage } from './errors'

beforeEach(() => {
  invoke.mockReset()
  newDoc()
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
})

describe('save', () => {
  it('writes to the existing path and records the saved content', async () => {
    // arrange a document already backed by a path, with unsaved edits
    doc.set({ path: '/tmp/a.md', content: 'body', savedContent: 'old', loadId: 1 })
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
    doc.set({ path: '/tmp/a.md', content: 'v1', savedContent: 'v0', loadId: 1 })
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
    doc.set({ path: '/tmp/a.md', content: 'body', savedContent: 'old', loadId: 1 })
    invoke.mockRejectedValue('disk full')
    await save()
    expect(get(errorMessage)).toContain('Could not save file')
    expect(isDirty(get(doc))).toBe(true)
  })
})
