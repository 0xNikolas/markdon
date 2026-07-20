import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc, openDoc, markSaved } from './doc'
import { reportError } from './errors'

interface OpenedFile {
  path: string
  content: string
}

export async function openPath(path: string, readonly = false): Promise<void> {
  try {
    const content = await invoke<string>('read_file', { path })
    openDoc(path, content, readonly)
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
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
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
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
