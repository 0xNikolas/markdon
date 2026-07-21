import { writable, type Writable } from 'svelte/store'

/**
 * The sidebar's "Open Files" list (task 21, MODE A / Stage 1): an ordered,
 * de-duplicated list of every opened document's PATH ONLY — never buffers.
 * The single-document model (doc.ts) is untouched: there is exactly one live
 * buffer, addressed by `$doc.path`. Switching to a list entry re-reads it
 * from disk through the existing guarded `openPath()`.
 *
 * Because switching away from a file always first resolves the dirty-guard
 * (Save/Discard/Cancel), a NON-ACTIVE entry can never be dirty — closing one
 * is therefore a pure array removal with no guard. Closing the ACTIVE entry
 * still runs the dirty-guard before removing it (see App.svelte's
 * `onCloseFile`).
 */
export const openList: Writable<string[]> = writable([])

/** Append `path` if absent; keep its first position on a redundant re-open. */
export function addOpen(list: string[], path: string): string[] {
  return list.includes(path) ? list : [...list, path]
}

/** Remove `path`; a no-op (referential no-op too) when it isn't present. */
export function removeOpen(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : list
}

/**
 * Which path should become active after `closing` is removed from `list`.
 * Closing a background (non-active) entry leaves `active` untouched. Closing
 * the active entry switches to the previous entry, else the next, else
 * `null` — the caller falls back to `newDoc()` when the list empties.
 */
export function neighbourAfterClose(
  list: string[],
  closing: string,
  active: string | null,
): string | null {
  if (closing !== active) return active
  const i = list.indexOf(closing)
  const rest = list.filter((p) => p !== closing)
  return rest[i - 1] ?? rest[i] ?? null
}
