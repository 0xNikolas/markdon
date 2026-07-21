import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  /** Exactly what our last read/write put on disk. Dirty ⇔ content differs. */
  savedContent: string
  /**
   * The WYSIWYG editor's canonical re-serialization of an untouched load, when
   * it differs from the file bytes (bullet style, escapes, trailing newline —
   * Milkdown re-emits the whole doc on its first doc-changing transaction).
   * A buffer equal to this baseline is logically CLEAN even though it differs
   * from `savedContent`; without it, merely opening such a file showed a
   * phantom "Edited" tag and a discard prompt on switch. `savedContent` stays
   * disk-truth — external-change classification depends on that.
   */
  normalized: string | null
  /** OS-opened files start read-only; lifted per-document via enableEditing. */
  readonly: boolean
  loadId: number
}

const initial: DocState = {
  path: null,
  content: '',
  savedContent: '',
  normalized: null,
  readonly: false,
  loadId: 0,
}

export const doc: Writable<DocState> = writable(initial)

/**
 * Paths whose documents are currently read-only. Readonly is a property of the
 * DOCUMENT, not of the open-call: a Finder-opened (or manually locked) file
 * must stay readonly when the user switches away via the sidebar and back —
 * call sites like handleOpenFile re-open with no flag and previously dropped
 * it, silently unlocking the buffer (and letting the editor's normalization
 * pass dirty an untouched file). Cleared by the same actions that lift
 * readonly on the live doc: enableEditing, a completed write (markSaved),
 * revertBuffer; moved by retargetPath alongside the file.
 */
const readonlyPaths = new Set<string>()

/** Test support: forget all remembered readonly paths. */
export function resetReadonlyMemory(): void {
  readonlyPaths.clear()
}

/**
 * Derived, never stored: the buffer differs from what we last synced to disk
 * AND from the editor's normalization baseline (see DocState.normalized) — a
 * buffer sitting exactly on either is clean.
 */
export function isDirty(
  s: Pick<DocState, 'content' | 'savedContent'> & { normalized?: string | null },
): boolean {
  return s.content !== s.savedContent && s.content !== (s.normalized ?? s.savedContent)
}

export function openDoc(path: string, content: string, readonly = false): void {
  if (readonly) readonlyPaths.add(path)
  const effective = readonly || readonlyPaths.has(path)
  doc.update((s) => ({
    path,
    content,
    savedContent: content,
    normalized: null, // fresh load: the editor re-derives its baseline
    readonly: effective,
    loadId: s.loadId + 1,
  }))
}

export function newDoc(): void {
  doc.update((s) => ({
    path: null,
    content: '',
    savedContent: '',
    normalized: null,
    readonly: false,
    loadId: s.loadId + 1,
  }))
}

export function edit(content: string): void {
  // A readonly buffer must stay clean even if the editor leaks an update event.
  doc.update((s) => (s.readonly ? s : { ...s, content }))
}

/**
 * Adopt the WYSIWYG editor's first re-serialization of an untouched load as
 * the clean baseline (see DocState.normalized): content moves to the editor's
 * canonical form without reading as dirty; `savedContent` stays disk-truth.
 * Defensive no-op on readonly or already-edited buffers — only the untouched
 * post-load state may adopt (App gates on the same condition; the store
 * re-checks so a racing edit can't be silently blessed as "normalization").
 */
export function adoptNormalization(content: string): void {
  doc.update((s) =>
    s.readonly || s.content !== s.savedContent ? s : { ...s, content, normalized: content },
  )
}

/**
 * Record a completed write: `savedContent` is what the write actually contained.
 * A completed write proves edit intent, so it also lifts readonly (no-op on the
 * ordinary save path, where readonly is already false).
 */
export function markSaved(path: string, savedContent: string): void {
  readonlyPaths.delete(path)
  // The baseline is void once a write lands: keeping it would let an undo back
  // to the pre-save serialization read as clean while differing from disk.
  doc.update((s) => ({ ...s, path, savedContent, normalized: null, readonly: false }))
}

export function enableEditing(): void {
  doc.update((s) => {
    if (s.path !== null) readonlyPaths.delete(s.path)
    return { ...s, readonly: false }
  })
}

/**
 * Manually enter read-only mode (task 25's File-menu toggle). Sets readonly=true
 * but ONLY on a clean buffer: the readonly⇒clean invariant every other path
 * relies on — edit() no-ops while readonly, save() short-circuits,
 * classifyExternalChange's rule order — must never be broken by stranding unsaved
 * edits behind the flag. The UI layer guarantees cleanliness first (routing a
 * dirty buffer through the discard guard before calling this); the store stays
 * defensive and no-ops if handed a dirty buffer anyway.
 */
export function enterReadonly(): void {
  doc.update((s) => {
    if (isDirty(s)) return s
    if (s.path !== null) readonlyPaths.add(s.path)
    return { ...s, readonly: true }
  })
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
  doc.update((s) => {
    if (s.path !== null) readonlyPaths.delete(s.path) // a revert makes the doc editable
    // Drop the baseline: a revert is a deliberate unsaved change and must read
    // dirty even if it happens to land on the old normalization.
    return { ...s, content, normalized: null, readonly: false, loadId: s.loadId + 1 }
  })
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
  // Move readonly memory alongside the file (exact match or subtree). Iterates
  // the whole set, but it only holds currently-locked docs — a handful at most.
  for (const p of [...readonlyPaths]) {
    if (p === oldPrefix) {
      readonlyPaths.delete(p)
      readonlyPaths.add(newPrefix)
    } else if (p.startsWith(oldPrefix + '/')) {
      readonlyPaths.delete(p)
      readonlyPaths.add(newPrefix + p.slice(oldPrefix.length))
    }
  }
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
  doc.update((s) => {
    if (s.path !== null) readonlyPaths.delete(s.path) // the path no longer exists on disk
    return { ...s, path: null, savedContent: '' }
  })
}
