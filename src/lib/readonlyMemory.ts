import { rewritePrefix, isSelfOrDescendant } from './paths'

/**
 * Per-path memory of which documents are read-only. Readonly is a property of
 * the DOCUMENT, not of the open-call: a Finder-opened (or manually locked) file
 * must stay readonly when the user switches away via the sidebar and back —
 * call sites like handleOpenFile re-open with no flag and would otherwise
 * silently unlock the buffer (letting the editor's normalization pass dirty an
 * untouched file). Kept out of DocState so it survives switching between files.
 *
 * doc.ts is the sole mutator during normal editing (lock on readonly open /
 * enterReadonly; unlock on enableEditing, markSaved, revertBuffer, detach; move
 * with retarget on rename). fileops.ts calls `forget` to prune locks when files
 * are deleted, regardless of whether the deleted file was the open one.
 */
export interface ReadonlyMemory {
  /** Is this exact path currently remembered as read-only? */
  has(path: string): boolean
  /** Remember `path` as read-only. */
  lock(path: string): void
  /** Forget the read-only mark for this exact path. */
  unlock(path: string): void
  /**
   * Follow a rename/move: rewrite every locked path under `oldPrefix` (exact
   * match or subtree) to sit under `newPrefix` instead. Segment-safe.
   */
  retarget(oldPrefix: string, newPrefix: string): void
  /**
   * Unlock every remembered path that is self-or-descendant of any path in
   * `paths` — used when files/folders are deleted so a later re-create at the
   * same path does not resurrect a stale readonly mark.
   */
  forget(paths: string[]): void
  /** Test support: forget everything. */
  reset(): void
}

const paths = new Set<string>()

export const readonlyMemory: ReadonlyMemory = {
  has(path) {
    return paths.has(path)
  },
  lock(path) {
    paths.add(path)
  },
  unlock(path) {
    paths.delete(path)
  },
  retarget(oldPrefix, newPrefix) {
    // Iterates the whole set, but it only holds currently-locked docs — a
    // handful at most.
    for (const p of [...paths]) {
      const rewritten = rewritePrefix(p, oldPrefix, newPrefix)
      if (rewritten !== p) {
        paths.delete(p)
        paths.add(rewritten)
      }
    }
  },
  forget(deleted) {
    if (deleted.length === 0) return
    for (const p of [...paths]) {
      if (deleted.some((d) => isSelfOrDescendant(p, d))) paths.delete(p)
    }
  },
  reset() {
    paths.clear()
  },
}
