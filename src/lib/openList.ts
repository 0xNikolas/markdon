import { writable, type Writable } from 'svelte/store'
import { isSelfOrDescendant, rewritePrefix } from './paths'

/**
 * The sidebar's "Open Files" list (MODE A): an ordered,
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
 * Follow a rename/move of any entry (file or an ANCESTOR folder) into
 * openList — mirrors doc.ts's `retargetPath`. Rewrites an exact match, or
 * every entry nested under a moved folder (segment-safe prefix rewrite),
 * keeping each entry's original position. A rewrite that lands on a path
 * already present in the list (e.g. moving a file onto a path a background
 * tab already occupies) is deduped, keeping the first occurrence's position.
 * A no-op (same reference) when nothing in the list is affected — so callers
 * can wire it into every fileops.ts mutation unconditionally.
 */
export function retargetOpen(list: string[], oldPrefix: string, newPrefix: string): string[] {
  let changed = false
  const rewritten = list.map((p) => {
    const r = rewritePrefix(p, oldPrefix, newPrefix)
    if (r !== p) changed = true
    return r
  })
  if (!changed) return list
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of rewritten) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Drop every entry that is `path` itself or nested beneath it (segment-safe)
 * — used when an entry is sent to Trash, since a deleted file/folder can no
 * longer be reopened and would otherwise leave a permanently dead row. A
 * no-op (same reference) when nothing in the list is affected.
 */
export function removeOpenSubtree(list: string[], path: string): string[] {
  const filtered = list.filter((p) => !isSelfOrDescendant(p, path))
  return filtered.length === list.length ? list : filtered
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
