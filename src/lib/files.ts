import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc, openDoc, markSaved } from './doc'
import { reportError } from './errors'
import { openList, previewPath, pinOpen } from './openList'
import { recordSave } from './history'
import { settings } from './settings'

interface OpenedFile {
  path: string
  content: string
}

/**
 * Load `path` into the single doc buffer. A `preview` open (sidebar single
 * click) keeps the path OUT of `openList` and parks it in the preview slot
 * instead — unless the path is already pinned, in which case previewing it is
 * meaningless and it stays a plain (pinned) open. A pinned open of the
 * currently-previewed path promotes it (pin-on-reopen). `readonly` keeps the
 * Finder/OS-association safety net (banner + "Enable editing").
 */
export async function openPath(
  path: string,
  opts: { preview?: boolean; readonly?: boolean } = {},
): Promise<void> {
  try {
    const content = await invoke<string>('read_file', { path })
    openDoc(path, content, opts.readonly ?? false)
    if (opts.preview && !get(openList).includes(path)) {
      previewPath.set(path) // replaces any previous preview — VS Code behavior
    } else {
      pinOpen(path)
    }
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
      pinOpen(p) // dialog opens are always pinned; drop a stale preview of the same path
    })
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

/**
 * Single choke-point for "open `path`, honoring the openMode preference".
 * MODE A ('tab', the default) opens in-place via the caller-supplied
 * `openInPlace` — the same guarded `openPath()` App.svelte already used. MODE B
 * ('window') spawns a second app window to host `path` and leaves the focused
 * window's own doc untouched. If spawning fails (e.g. the command is somehow
 * unavailable) it degrades gracefully to opening in place, so the preference is
 * never a dead end.
 *
 * `readonly` rides the hand-off so a Finder/OS-association open keeps its
 * read-only safety net (banner + "Enable editing") in the spawned window, the
 * same as MODE A's in-place `openPath(p, true)`. The in-place fallback is the
 * caller's closure, which already encodes its own readonly choice.
 */
export function openInPreferredTarget(
  path: string,
  openInPlace: (path: string) => void,
  readonly = false,
): void {
  if (get(settings).openMode === 'window') {
    spawnDocumentWindow(path, readonly).catch((e) => {
      reportError(`Could not open a new window: ${String(e)}`)
      openInPlace(path)
    })
    return
  }
  openInPlace(path)
}

/** The raw spawn both window-open paths share; callers own error handling. */
function spawnDocumentWindow(path: string, readonly: boolean): Promise<void> {
  return invoke('open_document_window', { path, readonly })
}

/**
 * Explicit "Open in New Window" (context menu): always spawns, regardless of
 * the openMode preference — that is the whole point of the action. Unlike
 * `openInPreferredTarget` there is no in-place fallback (the user asked for a
 * window, not for this window's doc to change), so a failure only reports.
 */
export async function openInNewWindow(path: string): Promise<void> {
  try {
    await spawnDocumentWindow(path, false)
  } catch (e) {
    reportError(`Could not open a new window: ${String(e)}`)
  }
}

export async function save(): Promise<void> {
  const state = get(doc)
  if (state.readonly) return // read-only docs are always clean; nothing to save
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path, state.content)
    // Best-effort File History snapshot: never awaited into the save
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
    pinOpen(selected)
    // The buffer now lives at `selected`; a preview row still pointing at the
    // doc's OLD path would be a dead row (its buffer just moved away).
    previewPath.update((p) => (p === state.path ? null : p))
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
