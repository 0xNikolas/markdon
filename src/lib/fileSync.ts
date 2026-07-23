import { invoke } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import { doc, openDoc, isDirty } from './doc'
import { reportError } from './errors'
import { watchStatus } from './ui'
import { recordExternal } from './history'
import { logInfo, logWarn } from './logging'
import { listenScoped } from './windowing'

/**
 * When set, the open file changed on disk while the buffer had unsaved edits.
 * Holds the on-disk content so the user can choose to reload it (or keep theirs).
 */
export const conflict: Writable<string | null> = writable(null)

/** On-disk content the user already declined to reload; suppresses re-prompting. */
let dismissedDisk: string | null = null

export type ExternalChange = 'ignore' | 'reload' | 'conflict'

/**
 * Decide what to do when the open file changed on disk. Pure so it can be tested
 * without the Tauri runtime.
 * - `ignore`  — disk matches the buffer (no real change), or disk matches what we
 *               last saved (our own write landing), or the user already declined
 *               this exact on-disk version.
 * - `reload`  — buffer is clean: silently adopt the on-disk content.
 * - `conflict`— buffer has unsaved edits that differ from disk: ask the user.
 */
export function classifyExternalChange(
  current: { content: string; savedContent: string; normalized?: string | null },
  disk: string,
  declined: string | null,
): ExternalChange {
  if (disk === current.content) return 'ignore'
  if (disk === current.savedContent) return 'ignore' // our own save; buffer just has newer edits
  // Clean per isDirty — including a buffer sitting on the editor's
  // normalization baseline (content differs from disk bytes, user typed
  // nothing): silently adopt the external version rather than prompting.
  if (!isDirty(current)) return 'reload'
  if (disk === declined) return 'ignore'
  return 'conflict'
}

/** Adopt the given on-disk content into the buffer (silent, marks clean). */
export function reloadFromDisk(content: string): void {
  const current = get(doc)
  if (current.path === null) return
  openDoc(current.path, content, current.readonly)
  // Record the adopted on-disk version so an external overwrite is recoverable
  // from File History. Best-effort; 'keep mine' dismissals record
  // nothing. Rust re-reads the file, so passing the path is enough.
  void recordExternal(current.path)
  conflict.set(null)
  dismissedDisk = null
}

/** Dismiss the conflict prompt, keeping the user's version. */
export function dismissConflict(): void {
  dismissedDisk = get(conflict)
  conflict.set(null)
}

/**
 * Re-read `path` from disk and react per {@link classifyExternalChange}:
 * clean+changed → silent reload (recorded to File History), dirty+changed →
 * conflict bar, otherwise ignore. Shared by the file-watcher listener and by
 * openPath's cache-hit restore (files.ts), where the restored entry's
 * savedContent is disk-truth-at-stash-time — so an external change to a
 * cached-but-inactive buffer surfaces through this same classifier with no
 * new logic.
 *
 * Both the path AND the loadId are re-checked after the await: path equality
 * alone covers a switch-away, but not a switch-away-and-back — a second
 * stash/restore of the same path while this read is in flight would otherwise
 * classify stale disk content against the newly restored buffer. Typing
 * doesn't bump loadId, so edits made while the read is in flight still
 * classify correctly (same as before the extraction).
 */
export async function reconcileWithDisk(path: string): Promise<void> {
  const before = get(doc)
  if (before.path !== path) return
  const loadId = before.loadId
  let disk: string
  try {
    disk = await invoke<string>('read_file', { path })
  } catch {
    // Expected during atomic writes — the file may be mid-write or removed.
    logInfo('external-change read skipped (file mid-write or removed)')
    return
  }
  const current = get(doc)
  if (current.path !== path || current.loadId !== loadId) return
  switch (classifyExternalChange(current, disk, dismissedDisk)) {
    case 'reload':
      reloadFromDisk(disk)
      break
    case 'conflict':
      conflict.set(disk)
      break
    case 'ignore':
      break
  }
}

/**
 * Start syncing the open file with disk: watch it for external changes and
 * react per {@link classifyExternalChange}. Returns a cleanup function.
 */
export async function initFileSync(): Promise<() => void> {
  let watchedPath: string | null = null

  const unsubDoc = doc.subscribe((s) => {
    if (s.path === watchedPath) return
    watchedPath = s.path
    // Switching files invalidates any pending conflict / decline for the old file.
    conflict.set(null)
    dismissedDisk = null
    watchStatus.set('idle')
    if (s.path) {
      const path = s.path
      invoke('watch_file', { path }).then(
        () => {
          // Guard: a path switch while the invoke was in flight means this
          // resolution is for a file we no longer watch — don't go green.
          if (watchedPath === path) watchStatus.set('watching')
        },
        (e) => {
          if (watchedPath === path) watchStatus.set('idle')
          reportError(`Could not watch file for external changes: ${String(e)}`)
        },
      )
    } else invoke('unwatch').catch((e) => logWarn('unwatch failed', e))
  })

  const unlisten = await listenScoped('file:external-change', async () => {
    const path = get(doc).path
    if (path === null) return
    await reconcileWithDisk(path)
  })

  return () => {
    unsubDoc()
    unlisten()
    watchStatus.set('idle')
    invoke('unwatch').catch((e) => logWarn('unwatch failed', e))
  }
}
