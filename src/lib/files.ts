import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc, openDoc, restoreDoc, markSaved, isDirty } from './doc'
import { reportError } from './errors'
import { openList, previewPath, pinOpen } from './openList'
import { recordSave } from './history'
import { settings } from './settings'
import { readonlyMemory } from './readonlyMemory'
import { reconcileWithDisk } from './fileSync'
import * as bufferCache from './bufferCache'

interface OpenedFile {
  path: string
  content: string
}

/** One drained OpenedFiles entry (mirrors Rust `OpenedEntry` in lib.rs):
    Finder/OS-association opens arrive readonly, argv hand-offs editable. */
export interface OpenedEntry {
  path: string
  readonly: boolean
}

/**
 * Stash the active PATHED document into the buffer cache before it is
 * switched away from, so its dirty edits (and cursor/scroll) survive to the
 * next switch-back instead of routing through a discard prompt. The single
 * stash choke-point: openPath calls it first thing, and App's switchGuarded
 * calls it before flows that replace the doc without openPath (newDoc, the
 * Open dialog).
 *
 * A clean PREVIEW is deliberately NOT stashed — previews are volatile (cache
 * keys ⊆ openList, the pinned paths). A dirty preview can't exist at switch
 * time by construction (promotePreviewOnEdit pins on edit), but the check is
 * defensive: a dirty pathed doc not in openList is pinned first, then
 * stashed — the stash must never silently drop unsaved edits.
 */
export function stashActive(): void {
  const s = get(doc)
  if (s.path === null) return // the untitled scratch has no cache key
  const pinned = get(openList).includes(s.path)
  const dirty = isDirty(s)
  if (!pinned && !dirty) return // clean preview: volatile by design
  if (!pinned) pinOpen(s.path) // defensive: never cache-drop unsaved edits
  bufferCache.stash(s.path, {
    content: s.content,
    savedContent: s.savedContent,
    normalized: s.normalized,
    view: bufferCache.captureViewState(),
  })
}

/**
 * Load `path` into the single doc buffer. A `preview` open (sidebar single
 * click) keeps the path OUT of `openList` and parks it in the preview slot
 * instead — unless the path is already pinned, in which case previewing it is
 * meaningless and it stays a plain (pinned) open. A pinned open of the
 * currently-previewed path promotes it (pin-on-reopen). `readonly` keeps the
 * Finder/OS-association safety net (banner + "Enable editing").
 *
 * The stash/restore choke-point: the outgoing doc is stashed first, then a
 * cache hit restores SYNCHRONOUSLY (no read_file blocking the switch) and
 * reconciles with disk in the background — an external change to the file
 * while it sat cached surfaces through the ordinary classifyExternalChange
 * (silent reload when the restored buffer is clean, conflict bar when dirty).
 * Stash-then-take also makes a self-switch (path === active path, reachable
 * via Cmd+W fallbacks and neighbour-after-close) a lossless round trip.
 */
export async function openPath(
  path: string,
  opts: { preview?: boolean; readonly?: boolean } = {},
): Promise<void> {
  stashActive()
  bufferCache.setPendingViewState(null) // a new open voids any earlier hand-off
  const cached = bufferCache.take(path)
  if (cached !== undefined) {
    // Honor a readonly open (Finder association) only for a clean entry:
    // locking a dirty restore would strand unsaved edits behind the flag,
    // breaking the readonly⇒clean invariant — the edits win.
    if (opts.readonly && !isDirty(cached)) readonlyMemory.lock(path)
    restoreDoc(path, cached)
    bufferCache.setPendingViewState(cached.view)
    if (opts.preview && !get(openList).includes(path)) {
      previewPath.set(path)
    } else {
      pinOpen(path)
    }
    void reconcileWithDisk(path) // background disk reconcile — never blocks the switch
    return
  }
  try {
    const content = await invoke<string>('read_file', { path })
    openDoc(path, content, opts.readonly ?? false)
    if (opts.preview && !get(openList).includes(path)) {
      previewPath.set(path) // replaces any previous preview — VS Code behavior
    } else {
      pinOpen(path)
    }
  } catch (e) {
    // The switch didn't happen — the outgoing doc is still live, so undo the
    // speculative stash. The LIVE doc must never also sit in the cache: a
    // lingering fork there would go stale as the user keeps editing, and a
    // later background save of it would clobber the newer buffer.
    const active = get(doc).path
    if (active !== null) bufferCache.evict(active)
    reportError(`Could not open file: ${String(e)}`)
  }
}

export async function open(): Promise<void> {
  try {
    // The dialog lives in Rust so the backend can vouch for the picked path.
    const picked = await invoke<OpenedFile | null>('open_file_dialog')
    if (picked === null) return // cancelled
    // Honor the openMode preference: 'window' spawns a fresh window for the
    // pick (re-read there); 'tab' opens the already-loaded content in place.
    openInPreferredTarget(picked.path, (p) => {
      if (bufferCache.peek(p) !== undefined) {
        // The pick is a cached background tab: restore its buffer (dirty
        // edits included) instead of clobbering it with the fresh disk read —
        // openPath's cache-hit path also reconciles with disk in background.
        void openPath(p)
        return
      }
      stashActive() // the pick replaces the doc without going through openPath
      openDoc(p, picked.content)
      pinOpen(p) // dialog opens are always pinned; drop a stale preview of the same path
    })
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

/**
 * Single choke-point for "open `path`, honoring the openMode preference".
 * MODE A ('tab', the default) opens in-place via the caller-supplied
 * `openInPlace` — the same guarded `openPath()` App.svelte already used. MODE B
 * ('window') spawns a second app window to host `path` and leaves the focused
 * window's own doc untouched. If spawning fails (e.g. the command is somehow
 * unavailable) it degrades gracefully to opening in place, so the preference is
 * never a dead end.
 *
 * `readonly` rides the hand-off so a Finder/OS-association open keeps its
 * read-only safety net (banner + "Enable editing") in the spawned window, the
 * same as MODE A's in-place `openPath(p, true)`. The in-place fallback is the
 * caller's closure, which already encodes its own readonly choice.
 */
export function openInPreferredTarget(
  path: string,
  openInPlace: (path: string) => void,
  readonly = false,
): void {
  if (get(settings).openMode === 'window') {
    spawnDocumentWindow(path, readonly).catch((e) => {
      reportError(`Could not open a new window: ${String(e)}`)
      openInPlace(path)
    })
    return
  }
  openInPlace(path)
}

/** The raw spawn both window-open paths share; callers own error handling. */
function spawnDocumentWindow(path: string, readonly: boolean): Promise<void> {
  return invoke('open_document_window', { path, readonly })
}

/**
 * Route a whole drained OpenedFiles batch (Finder opens / argv files), so a
 * multi-file drop never silently loses everything after the first entry. The
 * FIRST entry behaves exactly like a single open: through
 * `openInPreferredTarget` with the caller's `openFirstInPlace` closure as the
 * in-place path — it becomes the active doc (MODE A) or spawns its own window
 * (MODE B). Every REMAINING entry must still surface without stealing
 * activation, and `openInPreferredTarget(path, pinOpen, readonly)` does both
 * modes in one call: MODE B gives each file its own window (honoring its
 * per-entry readonly), MODE A pins it into the Open Files strip only —
 * paths-only, no read needed — and a MODE B spawn failure degrades to that
 * same visible pinned row instead of clobbering the active doc.
 */
export function openDrainedEntries(
  entries: OpenedEntry[],
  openFirstInPlace: (path: string, readonly: boolean) => void,
): void {
  const [first, ...rest] = entries
  if (first === undefined) return
  openInPreferredTarget(first.path, (p) => openFirstInPlace(p, first.readonly), first.readonly)
  for (const entry of rest) openInPreferredTarget(entry.path, pinOpen, entry.readonly)
}

/**
 * Explicit "Open in New Window" (context menu): always spawns, regardless of
 * the openMode preference — that is the whole point of the action. Unlike
 * `openInPreferredTarget` there is no in-place fallback (the user asked for a
 * window, not for this window's doc to change), so a failure only reports.
 */
export async function openInNewWindow(path: string): Promise<void> {
  try {
    await spawnDocumentWindow(path, false)
  } catch (e) {
    reportError(`Could not open a new window: ${String(e)}`)
  }
}

export async function save(): Promise<void> {
  const state = get(doc)
  if (state.readonly) return // read-only docs are always clean; nothing to save
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path, state.content)
    // Best-effort File History snapshot: never awaited into the save
    // outcome, errors swallowed inside recordSave — a history failure must never
    // turn a good save into a reported failure.
    void recordSave(state.path)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}

export async function saveAs(): Promise<void> {
  const state = get(doc)
  try {
    const selected = await invoke<string | null>('save_file_dialog', {
      defaultPath: state.path ?? 'untitled.md',
    })
    if (selected === null) return // cancelled
    await invoke('write_file', { path: selected, contents: state.content })
    markSaved(selected, state.content)
    // A background tab overwritten by this Save As must not later restore its
    // pre-overwrite buffer — the live doc IS that path's content now.
    bufferCache.evict(selected)
    void recordSave(selected) // best-effort history snapshot (see save())
    pinOpen(selected)
    // The buffer now lives at `selected`; a preview row still pointing at the
    // doc's OLD path would be a dead row (its buffer just moved away).
    previewPath.update((p) => (p === state.path ? null : p))
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}

/**
 * Save a CACHED (background-tab) buffer without making it the active doc —
 * the Save resolution when closing a dirty background tab, and the per-file
 * step of the window-close Save-all. Mirrors save(): write, adopt the written
 * content as the entry's disk baseline (markCachedSaved — the normalization
 * baseline is void once a write lands), lift any readonly lock (a completed
 * write proves edit intent), then a best-effort history snapshot. Returns
 * false on failure (reported) so the caller keeps its prompt up instead of
 * destroying the still-unsaved buffer; a clean or absent entry is trivially
 * true.
 */
export async function saveCachedBuffer(path: string): Promise<boolean> {
  const entry = bufferCache.peek(path)
  if (entry === undefined || !isDirty(entry)) return true
  try {
    await invoke('write_file', { path, contents: entry.content })
    bufferCache.markCachedSaved(path)
    readonlyMemory.unlock(path)
    void recordSave(path)
    return true
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
    return false
  }
}

/**
 * Window-close Save: the active doc first (via save(), which routes an
 * untitled scratch through Save As), then every dirty cached buffer. Reports
 * whether EVERYTHING came back clean — a partial failure (or a cancelled
 * Save As) returns false so the close prompt stays up with the remaining
 * dirty set intact; already-saved buffers aren't re-attempted on retry.
 */
export async function saveAllDirty(): Promise<boolean> {
  let allClean = true
  const active = get(doc)
  if (!active.readonly && isDirty(active)) {
    await save()
    if (isDirty(get(doc))) allClean = false
  }
  for (const path of bufferCache.anyCachedDirty()) {
    if (!(await saveCachedBuffer(path))) allClean = false
  }
  return allClean
}
