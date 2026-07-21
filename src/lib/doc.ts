import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  /** Exactly what our last read/write put on disk. Dirty ⇔ content differs. */
  savedContent: string
  /** OS-opened files start read-only; lifted per-document via enableEditing. */
  readonly: boolean
  loadId: number
}

const initial: DocState = { path: null, content: '', savedContent: '', readonly: false, loadId: 0 }

export const doc: Writable<DocState> = writable(initial)

/** Derived, never stored: the buffer differs from what we last synced to disk. */
export function isDirty(s: Pick<DocState, 'content' | 'savedContent'>): boolean {
  return s.content !== s.savedContent
}

export function openDoc(path: string, content: string, readonly = false): void {
  doc.update((s) => ({ path, content, savedContent: content, readonly, loadId: s.loadId + 1 }))
}

export function newDoc(): void {
  doc.update((s) => ({ path: null, content: '', savedContent: '', readonly: false, loadId: s.loadId + 1 }))
}

export function edit(content: string): void {
  // A readonly buffer must stay clean even if the editor leaks an update event.
  doc.update((s) => (s.readonly ? s : { ...s, content }))
}

/**
 * Record a completed write: `savedContent` is what the write actually contained.
 * A completed write proves edit intent, so it also lifts readonly (no-op on the
 * ordinary save path, where readonly is already false).
 */
export function markSaved(path: string, savedContent: string): void {
  doc.update((s) => ({ ...s, path, savedContent, readonly: false }))
}

export function enableEditing(): void {
  doc.update((s) => ({ ...s, readonly: false }))
}

/**
 * Load a File History version into the buffer as UNSAVED changes (task 24).
 * `savedContent` and `path` are left untouched — disk truth is unchanged — so
 * the doc reads as dirty and the user confirms with Cmd+S. `readonly` is cleared
 * (a revert always makes the buffer editable) and `loadId` is bumped so the
 * {#key $doc.loadId} block remounts the editor with the reverted text. Revert
 * NEVER writes disk directly.
 */
export function revertBuffer(content: string): void {
  doc.update((s) => ({ ...s, content, readonly: false, loadId: s.loadId + 1 }))
}

/**
 * Follow a rename/move of the open file — or of an ancestor folder of it — by
 * rewriting `path` in place. `oldPrefix`/`newPrefix` are the source and
 * destination paths of the moved entry (a file, or a folder whose subtree
 * contains the open doc). The buffer, dirty state, readonly flag and `loadId`
 * are all preserved, so editing continues seamlessly and the editor never
 * remounts; the path change alone re-points the file watcher (fileSync +
 * workspace both react to it). A no-op when the open doc isn't affected.
 */
export function retargetPath(oldPrefix: string, newPrefix: string): void {
  doc.update((s) => {
    if (s.path === null) return s
    if (s.path === oldPrefix) return { ...s, path: newPrefix }
    // Ancestor-folder move: rewrite the matching path prefix. The trailing
    // slash makes this segment-safe, so `/ws/proj` never matches `/ws/proj2`.
    if (s.path.startsWith(oldPrefix + '/')) {
      return { ...s, path: newPrefix + s.path.slice(oldPrefix.length) }
    }
    return s
  })
}

/**
 * Detach the open document from disk after its file (or an ancestor folder) was
 * moved to the Trash: keep the buffer on screen but drop `path` so it becomes an
 * unsaved Untitled document (content preserved, nothing lost). `savedContent` is
 * cleared so any non-empty buffer reads as dirty; `loadId` is untouched so the
 * editor keeps the live buffer rather than remounting empty.
 */
export function detachToUntitled(): void {
  doc.update((s) => ({ ...s, path: null, savedContent: '' }))
}
