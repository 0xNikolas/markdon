import { writable, type Writable } from 'svelte/store'
import { isSelfOrDescendant, rewritePrefix } from './paths'
import { isDirty } from './doc'

/**
 * The buffer cache behind instant tab switches: when the active document is
 * switched away from, its live state (content, disk baseline, normalization
 * baseline, cursor/scroll) is stashed here keyed by path, and restored —
 * dirty edits included — when the user switches back. This is what lets
 * switching between PATHED documents skip the discard prompt entirely: the
 * prompt survives only where the buffer would actually be destroyed (tab
 * close, window close, same-doc destructive actions, and the un-cacheable
 * untitled scratch).
 *
 * Membership invariant: cache keys ⊆ openList (pinned paths only). Previews
 * are volatile — a clean preview is simply dropped on switch-away — and the
 * stash choke-point (files.ts stashActive) defensively pins any dirty pathed
 * doc it sees before stashing. Purely in-memory; nothing persists.
 */

export interface ViewState {
  /** Which editor captured this; restore only into the same mode. */
  mode: 'wysiwyg' | 'source'
  /** Absolute selection-head offset (PM position / CM offset). */
  cursor: number
  /** scrollTop of the scrolling element. */
  scroll: number
}

export interface CachedBuffer {
  content: string
  savedContent: string
  normalized: string | null
  view: ViewState | null
}

/** Insertion order doubles as LRU order: stash() re-inserts on every update. */
const cache = new Map<string, CachedBuffer>()

/**
 * LRU cap over CLEAN entries only. Evicting a clean entry loses nothing but
 * cursor/scroll (the cache-miss path is the ordinary read_file open); a dirty
 * entry is unsaved data and is NEVER evicted by the cap — dirty entries are
 * bounded in practice by the pinned-tab count.
 */
export const MAX_CLEAN_CACHED = 20

/**
 * The set of cached paths whose buffers are dirty, updated by every mutator.
 * Lets the sidebar render a dirty dot on background rows and App gate window
 * close reactively without polling the Map.
 */
export const dirtyCached: Writable<ReadonlySet<string>> = writable(new Set())

function publishDirty(): void {
  dirtyCached.set(new Set(anyCachedDirty()))
}

function enforceCap(): void {
  let clean = 0
  for (const entry of cache.values()) if (!isDirty(entry)) clean++
  if (clean <= MAX_CLEAN_CACHED) return
  for (const [path, entry] of cache) {
    if (isDirty(entry)) continue
    cache.delete(path)
    if (--clean <= MAX_CLEAN_CACHED) return
  }
}

/** Stash (or refresh) `path`'s entry; delete+set keeps Map order = LRU order. */
export function stash(path: string, entry: CachedBuffer): void {
  cache.delete(path)
  cache.set(path, entry)
  enforceCap()
  publishDirty()
}

/**
 * Read AND remove `path`'s entry — restore consumes: once the buffer is live
 * in the doc store again, a lingering cache copy would just be a stale fork.
 */
export function take(path: string): CachedBuffer | undefined {
  const entry = cache.get(path)
  if (entry !== undefined) {
    cache.delete(path)
    publishDirty()
  }
  return entry
}

/** Read without consuming — for dirty checks and background saves. */
export function peek(path: string): CachedBuffer | undefined {
  return cache.get(path)
}

/** Drop `path`'s entry (tab closed — the buffer is deliberately destroyed). */
export function evict(path: string): void {
  if (cache.delete(path)) publishDirty()
}

/**
 * Drop every entry that is one of `paths` or nested beneath one — the cache
 * companion of openList.removeOpenSubtree / readonlyMemory.forget, wired into
 * performDelete. Segment-safe via isSelfOrDescendant.
 */
export function evictSubtree(paths: string[]): void {
  if (paths.length === 0) return
  let changed = false
  for (const key of [...cache.keys()]) {
    if (paths.some((p) => isSelfOrDescendant(key, p))) {
      cache.delete(key)
      changed = true
    }
  }
  if (changed) publishDirty()
}

/**
 * Follow a rename/move: rewrite every key under `oldPrefix` to sit under
 * `newPrefix`, mirroring retargetOpen. When a rewrite lands on a key that
 * already holds an entry, the MOVED entry wins: its savedContent describes
 * the file now at that path, while the pre-existing entry described a file
 * that no longer exists there.
 */
export function retarget(oldPrefix: string, newPrefix: string): void {
  const moved: [string, CachedBuffer][] = []
  for (const [key, entry] of cache) {
    const rewritten = rewritePrefix(key, oldPrefix, newPrefix)
    if (rewritten !== key) moved.push([rewritten, entry])
  }
  if (moved.length === 0) return
  for (const [key] of cache) {
    if (rewritePrefix(key, oldPrefix, newPrefix) !== key) cache.delete(key)
  }
  for (const [key, entry] of moved) {
    cache.delete(key) // moved entry wins a collision AND takes the newer LRU slot
    cache.set(key, entry)
  }
  publishDirty()
}

/** Is there a cached entry for `path` with unsaved edits? */
export function isCachedDirty(path: string): boolean {
  const entry = cache.get(path)
  return entry !== undefined && isDirty(entry)
}

/** Every cached path whose buffer is dirty, in LRU order. */
export function anyCachedDirty(): string[] {
  const out: string[] = []
  for (const [path, entry] of cache) if (isDirty(entry)) out.push(path)
  return out
}

/**
 * Record a completed background write of `path`'s cached buffer: the entry's
 * content is now disk truth, and the normalization baseline is void once a
 * write lands (same rationale as doc.ts markSaved). No-op when not cached.
 */
export function markCachedSaved(path: string): void {
  const entry = cache.get(path)
  if (entry === undefined) return
  cache.set(path, { ...entry, savedContent: entry.content, normalized: null })
  publishDirty()
}

// -- view-state capture/restore hand-off --------------------------------------

/**
 * The mounted editor's capture callback (same singleton pattern as
 * sourceEditor.ts registerSourceView: only one editor is ever mounted).
 * Editor.svelte registers a WYSIWYG provider, SourcePane a source one.
 */
let viewStateProvider: (() => ViewState) | null = null

export function registerViewStateProvider(fn: () => ViewState): void {
  viewStateProvider = fn
}

/** Unregister, gated on identity so a stale onDestroy can't clear a newer mount. */
export function unregisterViewStateProvider(fn: () => ViewState): void {
  if (viewStateProvider === fn) viewStateProvider = null
}

/** Best-effort snapshot of the mounted editor's cursor/scroll; null when no
 * editor is mounted or the provider throws — a capture failure must never
 * break a switch. */
export function captureViewState(): ViewState | null {
  try {
    return viewStateProvider?.() ?? null
  } catch {
    return null
  }
}

/**
 * Pending view-state hand-off across the {#key loadId} remount (mirrors
 * pendingLine in sourceEditor.ts): openPath parks the restored entry's view
 * state here; the editor that mounts next consumes it. Mode-gated: a stashed
 * WYSIWYG state never restores into a source pane (and vice versa) — the
 * offsets don't translate, so a mismatch is a silent skip.
 */
let pendingView: ViewState | null = null

export function setPendingViewState(vs: ViewState | null): void {
  pendingView = vs
}

/** Return-and-clear the pending view state iff its mode matches the mounting
 * editor's; a mismatch leaves it parked (benign: openPath resets the slot on
 * every open, so it can only ever describe the current document). */
export function consumePendingViewState(mode: ViewState['mode']): ViewState | null {
  if (pendingView === null || pendingView.mode !== mode) return null
  const vs = pendingView
  pendingView = null
  return vs
}

/** Test support: drop every entry and any pending view state. */
export function reset(): void {
  cache.clear()
  pendingView = null
  viewStateProvider = null
  publishDirty()
}
