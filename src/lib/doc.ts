import { writable, type Writable } from 'svelte/store'
import { rewritePrefix, isSelfOrDescendant } from './paths'
import { readonlyMemory } from './readonlyMemory'

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

// Enabled under vitest (process.env.NODE_ENV === 'test') and any non-production
// Vite build (import.meta.env.DEV) — both are statically replaced at build
// time, so this stays dead code (and the check below tree-shaken away) in a
// production Tauri build, and runs under `vitest run`'s node environment
// where import.meta.env.DEV is also true, but process.env.NODE_ENV is the
// more direct signal there.
const ASSERT_INVARIANTS = Boolean(import.meta.env?.DEV) || process.env.NODE_ENV === 'test'

/**
 * Every mutation of `doc` routes through here (never doc.update directly) so
 * the readonly=>clean invariant is checked in one place after every
 * transition, not re-derived per call site. See enterReadonly's docstring for
 * why the invariant matters; this is the enforcement backstop for it.
 */
function updateDoc(fn: (s: DocState) => DocState): void {
  doc.update((s) => {
    const next = fn(s)
    if (ASSERT_INVARIANTS && next.readonly && isDirty(next)) {
      throw new Error(
        `doc invariant violated: readonly=true with a dirty buffer (path=${String(next.path)}). ` +
          'Every transition that sets readonly must also guarantee a clean buffer.',
      )
    }
    return next
  })
}

/**
 * Per-path readonly memory lives in ./readonlyMemory (an explicit interface
 * shared with fileops.ts). Readonly is a property of the DOCUMENT, not of the
 * open-call: a Finder-opened (or manually locked) file must stay readonly when
 * the user switches away via the sidebar and back. doc.ts locks on a readonly
 * open / enterReadonly and unlocks on the actions that lift readonly on the
 * live doc — enableEditing, a completed write (markSaved), revertBuffer — and
 * moves the mark with retargetPath alongside the file.
 */

/** Test support: forget all remembered readonly paths. */
export function resetReadonlyMemory(): void {
  readonlyMemory.reset()
}

/** Test support: build a DocState for direct doc.set() in tests, overriding
 * only the fields a test cares about — the rest come from the same `initial`
 * production code starts from. */
export function docWith(overrides: Partial<DocState> = {}): DocState {
  return { ...initial, ...overrides }
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
  if (readonly) readonlyMemory.lock(path)
  const effective = readonly || readonlyMemory.has(path)
  updateDoc((s) => ({
    path,
    content,
    savedContent: content,
    normalized: null, // fresh load: the editor re-derives its baseline
    readonly: effective,
    loadId: s.loadId + 1,
  }))
}

export function newDoc(): void {
  updateDoc((s) => ({
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
  updateDoc((s) => (s.readonly ? s : { ...s, content }))
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
  updateDoc((s) =>
    s.readonly || s.content !== s.savedContent ? s : { ...s, content, normalized: content },
  )
}

/**
 * Record a completed write: `savedContent` is what the write actually contained.
 * A completed write proves edit intent, so it also lifts readonly (no-op on the
 * ordinary save path, where readonly is already false).
 */
export function markSaved(path: string, savedContent: string): void {
  readonlyMemory.unlock(path)
  // The baseline is void once a write lands: keeping it would let an undo back
  // to the pre-save serialization read as clean while differing from disk.
  updateDoc((s) => ({ ...s, path, savedContent, normalized: null, readonly: false }))
}

export function enableEditing(): void {
  updateDoc((s) => {
    if (s.path !== null) readonlyMemory.unlock(s.path)
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
  updateDoc((s) => {
    if (isDirty(s)) return s
    if (s.path !== null) readonlyMemory.lock(s.path)
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
  updateDoc((s) => {
    if (s.path !== null) readonlyMemory.unlock(s.path) // a revert makes the doc editable
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
  readonlyMemory.retarget(oldPrefix, newPrefix) // move the mark alongside the file
  updateDoc((s) => {
    if (s.path === null) return s
    const rewritten = rewritePrefix(s.path, oldPrefix, newPrefix)
    return rewritten === s.path ? s : { ...s, path: rewritten }
  })
}

/**
 * Detach the open document to an unsaved Untitled doc — but ONLY if its file
 * (or an ancestor folder) is among `deletedPaths`. The self-or-descendant
 * decision runs INSIDE updateDoc against the LIVE doc state, so a doc switch
 * that raced the delete's await cannot detach the wrong document (DEFECT A2):
 * the caller must not branch on a pre-await snapshot of the open path.
 *
 * When it does detach: keep the buffer on screen but drop `path` (content
 * preserved, nothing lost). `savedContent` is cleared so any non-empty buffer
 * reads as dirty; `loadId` is untouched so the editor keeps the live buffer
 * rather than remounting empty. `readonly` is cleared too — readonly locks a
 * FILE, and a detached doc no longer has one; leaving it set would strand a
 * (now provably dirty, since savedContent just went to '') buffer behind the
 * flag, breaking the readonly=>clean invariant updateDoc asserts. Returns
 * whether it detached, so the caller only surfaces the "moved to Trash"
 * notice when the open doc was actually affected.
 */
export function detachIfAffected(deletedPaths: string[]): boolean {
  let detached = false
  updateDoc((s) => {
    if (s.path === null) return s
    if (!deletedPaths.some((p) => isSelfOrDescendant(s.path as string, p))) return s
    readonlyMemory.unlock(s.path) // the path no longer exists on disk
    detached = true
    return { ...s, path: null, savedContent: '', readonly: false }
  })
  return detached
}
