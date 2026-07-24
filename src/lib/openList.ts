import { get, writable, type Writable } from 'svelte/store'
import { isSelfOrDescendant, rewritePrefix } from './paths'
import { ASSERT_INVARIANTS } from './assertInvariant'

/**
 * The sidebar's "Open Files" list (MODE A): a de-duplicated list of every
 * opened document's PATH ONLY — never buffers — ordered MOST-RECENTLY-OPENED
 * FIRST (a new open is prepended at index 0, so the top row is the newest).
 * Re-activating or switching to an already-open row NEVER reorders it: a strip
 * that reshuffled on every switch would jump under the pointer and make
 * Ctrl+Tab loop over just the two most-recent rows. Opening order is therefore
 * a stable record of first-open recency, not a live MRU.
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
 * renders as one extra italic row at the TOP of the strip — a preview is the
 * most recent open by definition, so it sits above every pinned row. A new
 * preview simply replaces the old one (the previous previewed file vanishes
 * from the strip, its top slot unchanged), and pinning — double-click,
 * explicit open, or editing the buffer — prepends the path into `openList`
 * (index 0, the same top slot: no visible jump) and clears this slot. `null`
 * means no preview row.
 */
export const previewPath: Writable<string | null> = writable(null)

/**
 * Prepend `path` (most-recently-opened first) if absent; keep its current
 * position on a redundant re-open, so switching back to an already-open row
 * never reshuffles the strip.
 */
export function addOpen(list: string[], path: string): string[] {
  return list.includes(path) ? list : [path, ...list]
}

/** Remove `path`; a no-op (referential no-op too) when it isn't present. */
export function removeOpen(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : list
}

/**
 * Insert `path` at `index` (clamped to the list's bounds) — Reopen Closed
 * File's "back at its old position" re-insert. Indexes count from the TOP
 * (index 0 is the newest/top row), matching the newest-first list order, so a
 * file closed at row N reopens at row N when it still fits. Already-present
 * paths are a referential no-op, keeping their current position (the file was
 * manually reopened in the meantime; a duplicate row must never appear).
 */
export function insertOpenAt(list: string[], path: string, index: number): string[] {
  if (list.includes(path)) return list
  const i = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, i), path, ...list.slice(i)]
}

/**
 * The strip's visible row order, TOP to bottom: the preview row FIRST when one
 * is showing (the most recent open), then the pinned rows (themselves newest
 * first) — exactly what OpenFilesStrip.svelte renders (a preview that is also
 * pinned draws no extra row, mirrored here). Shared by cycling, bulk-close
 * planning, and the close-time index recorded for Reopen Closed File.
 */
export function stripOrder(open: string[], preview: string | null): string[] {
  return preview !== null && !open.includes(preview) ? [preview, ...open] : open
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
 * Pin `path`: prepend it to `openList` (index 0, the top row — most recently
 * opened) and, when it was the previewed file, vacate the preview slot — the
 * single transition from "italic preview row" to "pinned row". Because the
 * preview already rendered at the top, promoting it lands in the same visible
 * slot with no jump. Safe for paths that were never previewed (plain open),
 * and a no-op for an already-pinned path (it keeps its row).
 */
export function pinOpen(path: string): void {
  openList.update((l) => addOpen(l, path))
  previewPath.update((p) => (p === path ? null : p))
  // Invariant (dev/test only): the preview slot and the pinned list stay
  // disjoint. pinOpen is the transition that could seat a preview in the pinned
  // list, so it is the enforcement point. Statically dead in a production build.
  if (ASSERT_INVARIANTS) {
    const preview = get(previewPath)
    if (preview !== null && get(openList).includes(preview)) {
      throw new Error(
        `openList invariant violated: previewPath (${preview}) is also in openList ` +
          `after pinOpen('${path}'). The preview slot and pinned list must stay disjoint.`,
      )
    }
  }
}

/** Pin the current preview, if any (dblclick on the row, or editing the buffer). */
export function pinPreview(): void {
  const p = get(previewPath)
  if (p !== null) pinOpen(p)
}

/**
 * The next/previous path for Ctrl+Tab file cycling, in STRIP ORDER: the
 * preview row first (when one is showing), then the pinned rows (`open`, as
 * displayed, newest first) — the exact row order OpenFilesStrip.svelte renders
 * (its `previewRow` hides a preview that is also pinned, mirrored here).
 * 'next' (dir +1) walks DOWN the strip from the active row — top is the most
 * recent, so next steps toward older rows — and wraps off the bottom back to
 * the top. Deliberately a simple wrap-around cycle over that visible order,
 * NOT VS Code's MRU picker overlay — this app's strip has no z-order to
 * surface, and a plain cycle stays predictable with no extra UI.
 *
 * `dir` is +1 (next) or -1 (previous), wrapping at either end. Returns null —
 * cycle from an active strip row with no other row to go to (fewer than 2
 * rows), or an empty strip. An active doc NOT in the strip (the untitled
 * scratch, which has no row) enters the cycle instead: next lands on the
 * first row, previous on the last — VS Code's Ctrl+Tab-from-untitled
 * behavior — so a single row IS reachable from there.
 */
export function neighbourInStrip(
  current: string | null,
  open: string[],
  preview: string | null,
  dir: 1 | -1,
): string | null {
  const strip = stripOrder(open, preview)
  if (strip.length === 0) return null
  const i = current === null ? -1 : strip.indexOf(current)
  if (i === -1) return dir === 1 ? strip[0] : strip[strip.length - 1]
  if (strip.length < 2) return null
  return strip[(i + dir + strip.length) % strip.length]
}

// -- strip context-menu bulk closes -------------------------------------------

export type BulkCloseKind = 'others' | 'saved' | 'all'

export interface BulkClosePlan {
  /** Background rows to close immediately — all guaranteed clean. */
  close: string[]
  /** Dirty background rows deliberately kept open (the caller notices them). */
  keptDirty: string[]
  /** Close the ACTIVE row too, via the caller's normal guarded close path. */
  closeActive: boolean
}

/**
 * Which strip rows a context-menu bulk close ('Close Others' / 'Close Saved'
 * / 'Close All' on `target`) actually closes. Deliberately SIMPLER than VS
 * Code's per-file prompt chain, and honest about it:
 *
 * - Dirty BACKGROUND rows (unsaved edits stashed in the buffer cache) are
 *   never closed by a bulk action — 'others'/'all' SKIP them and report the
 *   kept count via `keptDirty` (the caller shows one notice), instead of
 *   walking a sequential prompt chain through the single discard overlay.
 *   'saved' excludes them by definition (they aren't saved), so it reports no
 *   `keptDirty` — nothing was skipped that was supposed to close.
 * - The ACTIVE row is kept by 'others' (even when it isn't `target`) and by
 *   'saved'; only 'all' closes it — via `closeActive`, which the caller
 *   routes through its ordinary guarded close so a dirty live doc still gets
 *   its one prompt. An active doc with no strip row (the untitled scratch)
 *   yields closeActive=false — 'all' only empties the strip around it.
 *
 * `rows` is the strip's visible order (see stripOrder); `dirty` is the
 * cached-dirty set (bufferCache.dirtyCached — the live doc's dirtiness is the
 * guarded path's business, not this plan's).
 */
export function bulkClosePlan(
  kind: BulkCloseKind,
  rows: readonly string[],
  target: string,
  active: string | null,
  dirty: ReadonlySet<string>,
): BulkClosePlan {
  const background = rows.filter((p) => p !== active)
  const candidates = kind === 'others' ? background.filter((p) => p !== target) : background
  return {
    close: candidates.filter((p) => !dirty.has(p)),
    keptDirty: kind === 'saved' ? [] : candidates.filter((p) => dirty.has(p)),
    closeActive: kind === 'all' && active !== null && rows.includes(active),
  }
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
