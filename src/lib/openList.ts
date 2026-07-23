import { get, writable, type Writable } from 'svelte/store'
import { isSelfOrDescendant, rewritePrefix } from './paths'

/**
 * The sidebar's "Open Files" list (MODE A): an ordered,
 * de-duplicated list of every opened document's PATH ONLY — never buffers.
 * The single-document model (doc.ts) is untouched: there is exactly one live
 * buffer, addressed by `$doc.path`. Switching to a list entry restores its
 * stashed buffer from the buffer cache (bufferCache.ts) when one exists, and
 * re-reads it from disk otherwise — both through `openPath()`.
 *
 * Because switching away from a pinned file stashes its live state, a
 * NON-ACTIVE entry CAN be dirty (its unsaved edits sit in the cache; cache
 * keys ⊆ this list). Closing such an entry therefore runs the discard guard
 * before the removal + cache eviction; a clean non-active entry closes as a
 * bare removal. Closing the ACTIVE entry still runs the dirty-guard against
 * the live doc (see App.svelte's `onCloseFile`).
 */
export const openList: Writable<string[]> = writable([])

/**
 * The single-click PREVIEW slot (VS Code semantics): a normal live doc in the
 * `doc` store — editable, dirty-guarded — whose path is NOT in `openList`. It
 * renders as one extra italic row after the pinned rows. A new preview simply
 * replaces the old one (the previous previewed file vanishes from the strip),
 * and pinning — double-click, explicit open, or editing the buffer — moves the
 * path into `openList` and clears this slot. `null` means no preview row.
 */
export const previewPath: Writable<string | null> = writable(null)

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
 * Follow a rename/move into the preview slot — the preview companion of
 * `retargetOpen`. Rewrites an exact match or a preview nested under a moved
 * folder (segment-safe, via the same `rewritePrefix`); `null` and unaffected
 * previews pass through unchanged, so callers can wire it into every
 * fileops.ts mutation unconditionally.
 */
export function retargetPreview(
  preview: string | null,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  return preview === null ? null : rewritePrefix(preview, oldPrefix, newPrefix)
}

/**
 * Clear the preview slot when `path` (a trashed file or folder) is the preview
 * itself or an ancestor of it — the preview companion of `removeOpenSubtree`:
 * a deleted preview can't be reopened and would otherwise leave a dead italic
 * row. Unrelated previews (and `null`) pass through unchanged.
 */
export function clearPreviewInSubtree(preview: string | null, path: string): string | null {
  return preview !== null && isSelfOrDescendant(preview, path) ? null : preview
}

/**
 * Pin `path`: append it to `openList` and, when it was the previewed file,
 * vacate the preview slot — the single transition from "italic preview row"
 * to "pinned row". Safe for paths that were never previewed (plain open).
 */
export function pinOpen(path: string): void {
  openList.update((l) => addOpen(l, path))
  previewPath.update((p) => (p === path ? null : p))
}

/** Pin the current preview, if any (dblclick on the row, or editing the buffer). */
export function pinPreview(): void {
  const p = get(previewPath)
  if (p !== null) pinOpen(p)
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
