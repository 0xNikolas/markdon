import { invoke } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import { doc, openDoc } from './doc'
import { reportError } from './errors'
import { watchStatus } from './ui'
import { recordExternal } from './history'
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
  current: { content: string; savedContent: string },
  disk: string,
  declined: string | null,
): ExternalChange {
  if (disk === current.content) return 'ignore'
  if (disk === current.savedContent) return 'ignore' // our own save; buffer just has newer edits
  if (current.content === current.savedContent) return 'reload'
  if (disk === declined) return 'ignore'
  return 'conflict'
}

/** Adopt the given on-disk content into the buffer (silent, marks clean). */
export function reloadFromDisk(content: string): void {
  const current = get(doc)
  if (current.path === null) return
  openDoc(current.path, content, current.readonly)
  // Record the adopted on-disk version so an external overwrite is recoverable
  // from File History (task 24). Best-effort; 'keep mine' dismissals record
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
    } else invoke('unwatch').catch(() => {})
  })

  const unlisten = await listenScoped('file:external-change', async () => {
    const before = get(doc)
    if (before.path === null) return
    let disk: string
    try {
      disk = await invoke<string>('read_file', { path: before.path })
    } catch {
      return // file may be mid-write or removed; ignore this event
    }
    // Re-read state after the await: the user may have switched files or typed
    // while the read was in flight. Acting on the stale snapshot could apply this
    // file's disk content to a different (or now-edited) buffer — silent data loss.
    const current = get(doc)
    if (current.path !== before.path) return
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
  })

  return () => {
    unsubDoc()
    unlisten()
    watchStatus.set('idle')
    invoke('unwatch').catch(() => {})
  }
}
