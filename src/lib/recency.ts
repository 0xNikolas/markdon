/**
 * Session-only recency of document loads, for Quick Open's recency-sorted
 * sections: every PATHED load through doc.ts's chokepoint (openDoc /
 * restoreDoc — never newDoc, the untitled scratch has no path to rank)
 * bumps the path's sequence number. A monotonic counter rather than
 * timestamps: only the ORDER of loads matters, and a counter can't tie or
 * go backwards when two loads land in the same millisecond.
 *
 * Deliberately session-only — the map dies with the window. Persisting it
 * (ui.json, alongside the other per-workspace UI state) is a later concern;
 * within one session the recall "the file I just left" is what recency
 * sorting is for, and a cold boot falling back to tree order is fine.
 */

let seq = 0
const lastLoad = new Map<string, number>()

/** Record that `path` was just loaded — it becomes the most recent. */
export function touchRecency(path: string): void {
  lastLoad.set(path, ++seq)
}

/**
 * `path`'s load sequence: higher = more recently loaded; 0 = never loaded
 * this session (every real bump is >= 1, so 0 is a safe "unknown" floor).
 */
export function recencyOf(path: string): number {
  return lastLoad.get(path) ?? 0
}

/** Test support: forget every recorded load and restart the sequence. */
export function resetRecency(): void {
  lastLoad.clear()
  seq = 0
}
