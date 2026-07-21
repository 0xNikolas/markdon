import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc, openDoc, markSaved } from './doc'
import { reportError } from './errors'
import { openList, addOpen } from './openList'
import { recordSave } from './history'
import { settings } from './settings'

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
    // Honor the openMode preference: 'window' spawns a fresh window for the
    // pick (re-read there); 'tab' opens the already-loaded content in place.
    openInPreferredTarget(picked.path, (p) => {
      openDoc(p, picked.content)
      openList.update((l) => addOpen(l, p))
    })
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

/**
 * Single choke-point for "open `path`, honoring the openMode preference"
 * (task 21). MODE A ('tab', the default) opens in-place via the caller-supplied
 * `openInPlace` — the same guarded `openPath()` App.svelte already used. MODE B
 * ('window') spawns a second app window to host `path` and leaves the focused
 * window's own doc untouched. If spawning fails (e.g. the command is somehow
 * unavailable) it degrades gracefully to opening in place, so the preference is
 * never a dead end.
 */
export function openInPreferredTarget(path: string, openInPlace: (path: string) => void): void {
  if (get(settings).openMode === 'window') {
    invoke('open_document_window', { path }).catch((e) => {
      reportError(`Could not open a new window: ${String(e)}`)
      openInPlace(path)
    })
    return
  }
  openInPlace(path)
}

export async function save(): Promise<void> {
  const state = get(doc)
  if (state.readonly) return // read-only docs are always clean; nothing to save
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path, state.content)
    // Best-effort File History snapshot (task 24): never awaited into the save
    // outcome, errors swallowed inside recordSave — a history failure must never
    // turn a good save into a reported failure.
    void recordSave(state.path)
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
    void recordSave(selected) // best-effort history snapshot (see save())
    openList.update((l) => addOpen(l, selected))
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
