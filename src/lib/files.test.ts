import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
const openDialog = vi.fn()
const saveDialog = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: (...a: unknown[]) => saveDialog(...a),
}))

import { document, newDoc, edit } from './document'
import { open, save, saveAs } from './files'
import { errorMessage } from './errors'

beforeEach(() => {
  invoke.mockReset()
  openDialog.mockReset()
  saveDialog.mockReset()
  newDoc()
})

describe('open', () => {
  it('loads the picked file into the store', async () => {
    openDialog.mockResolvedValue('/tmp/a.md')
    invoke.mockResolvedValue('# Loaded')
    await open()
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/tmp/a.md' })
    const s = get(document)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# Loaded')
    expect(s.dirty).toBe(false)
  })

  it('does nothing when the dialog is cancelled', async () => {
    openDialog.mockResolvedValue(null)
    await open()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('save', () => {
  it('writes to the existing path and clears dirty', async () => {
    // arrange a document already backed by a path
    document.set({ path: '/tmp/a.md', content: 'body', dirty: true, loadId: 1 })
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/a.md', contents: 'body' })
    expect(get(document).dirty).toBe(false)
  })

  it('falls back to Save As when there is no path', async () => {
    newDoc()
    edit('draft')
    saveDialog.mockResolvedValue('/tmp/new.md')
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/new.md', contents: 'draft' })
    expect(get(document).path).toBe('/tmp/new.md')
    expect(get(document).dirty).toBe(false)
  })
})

describe('saveAs', () => {
  it('does nothing when the save dialog is cancelled', async () => {
    newDoc()
    edit('draft')
    saveDialog.mockResolvedValue(null)
    await saveAs()
    expect(invoke).not.toHaveBeenCalled()
    expect(get(document).dirty).toBe(true)
  })
})

describe('error handling', () => {
  it('reports an error when read_file rejects', async () => {
    errorMessage.set(null)
    openDialog.mockResolvedValue('/tmp/a.md')
    invoke.mockRejectedValue('boom')
    await open()
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('reports an error when write_file rejects and keeps dirty', async () => {
    errorMessage.set(null)
    document.set({ path: '/tmp/a.md', content: 'body', dirty: true, loadId: 1 })
    invoke.mockRejectedValue('disk full')
    await save()
    expect(get(errorMessage)).toContain('Could not save file')
    expect(get(document).dirty).toBe(true)
  })
})
