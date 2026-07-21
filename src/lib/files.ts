import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc, openDoc, markSaved } from './doc'
import { reportError } from './errors'
import { openList, addOpen } from './openList'

interface OpenedFile {
  path: string
  content: string
}

export async function openPath(path: string, readonly = false): Promise<void> {
  try {
    const content = await invoke<string>('read_file', { path })
    openDoc(path, content, readonly)
    openList.update((l) => addOpen(l, path))
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

export async function open(): Promise<void> {
  try {
    // The dialog lives in Rust so the backend can vouch for the picked path.
    const picked = await invoke<OpenedFile | null>('open_file_dialog')
    if (picked === null) return // cancelled
    openDoc(picked.path, picked.content)
    openList.update((l) => addOpen(l, picked.path))
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

/**
 * Single choke-point for "open `path`, honoring the openMode preference"
 * (task 21). Stage 1 (MODE A only) always opens in-place via the
 * caller-supplied `openInPlace` — the same guarded `openPath()` App.svelte
 * already used pre-feature. Stage 2 will branch here: when
 * `get(settings).openMode === 'window'`, invoke `open_document_window`
 * instead of calling `openInPlace`, leaving the focused window's own doc
 * untouched.
 */
export function openInPreferredTarget(path: string, openInPlace: (path: string) => void): void {
  openInPlace(path)
}

export async function save(): Promise<void> {
  const state = get(doc)
  if (state.readonly) return // read-only docs are always clean; nothing to save
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path, state.content)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}

export async function saveAs(): Promise<void> {
  const state = get(doc)
  try {
    const selected = await invoke<string | null>('save_file_dialog', {
      defaultPath: state.path ?? 'untitled.md',
    })
    if (selected === null) return // cancelled
    await invoke('write_file', { path: selected, contents: state.content })
    markSaved(selected, state.content)
    openList.update((l) => addOpen(l, selected))
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
