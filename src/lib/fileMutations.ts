import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { retargetPath, detachIfAffected } from './doc'
import { reportError, reportNotice } from './errors'
import { workspace, refreshWorkspace } from './workspace'
import {
  openList,
  previewPath,
  retargetOpen,
  retargetPreview,
  removeOpenSubtree,
  clearPreviewInSubtree,
} from './openList'
import { readonlyMemory } from './readonlyMemory'
import { isSelfOrDescendant } from './paths'
import { selection, focused, clipboard } from './fileOpsState'
import { pasteTargetDir, folderPaths } from './fileTree'

/**
 * The command wrappers that drive the Rust file-ops backend, plus the
 * high-level operations that keep the doc, Open Files strip, and sidebar
 * state consistent around each mutation. The backend re-derives all trust
 * from the allowlist, so these paths are UI convenience only — never a
 * security boundary.
 */

// -- command wrappers ---------------------------------------------------------

export function createFile(dir: string, name: string): Promise<string> {
  return invoke<string>('create_file', { dir, name })
}
export function createFolder(dir: string, name: string): Promise<string> {
  return invoke<string>('create_folder', { dir, name })
}
export function renameEntry(path: string, newName: string): Promise<string> {
  return invoke<string>('rename_entry', { path, newName })
}
export function moveEntry(src: string, destDir: string): Promise<string> {
  return invoke<string>('move_entry', { src, destDir })
}
export function copyEntry(src: string, destDir: string): Promise<string> {
  return invoke<string>('copy_entry', { src, destDir })
}
export function duplicateEntry(path: string): Promise<string> {
  return invoke<string>('duplicate_entry', { path })
}
export function deleteEntries(paths: string[]): Promise<void> {
  return invoke('delete_entries', { paths })
}

// -- high-level operations (backend + doc-consistency + refresh) --------------

function afterMutation(selected: string[]): void {
  selection.set(new Set(selected))
  focused.set(selected.length > 0 ? selected[selected.length - 1] : null)
}

export async function performCreateFile(dir: string, name: string): Promise<void> {
  try {
    const p = await createFile(dir, name)
    await refreshWorkspace()
    afterMutation([p])
  } catch (e) {
    reportError(`Could not create file: ${String(e)}`)
  }
}

export async function performCreateFolder(dir: string, name: string): Promise<void> {
  try {
    const p = await createFolder(dir, name)
    await refreshWorkspace()
    afterMutation([p])
  } catch (e) {
    reportError(`Could not create folder: ${String(e)}`)
  }
}

export async function performRename(path: string, newName: string): Promise<void> {
  try {
    const p = await renameEntry(path, newName)
    retargetPath(path, p) // follow the open doc if it (or an ancestor) moved
    openList.update((l) => retargetOpen(l, path, p)) // keep the Open Files strip in sync
    previewPath.update((pv) => retargetPreview(pv, path, p)) // …and its preview row
    await refreshWorkspace()
    afterMutation([p])
  } catch (e) {
    reportError(`Could not rename: ${String(e)}`)
  }
}

export async function performDuplicate(path: string): Promise<void> {
  try {
    const p = await duplicateEntry(path)
    await refreshWorkspace()
    afterMutation([p])
  } catch (e) {
    reportError(`Could not duplicate: ${String(e)}`)
  }
}

/**
 * Move each path into `destDir`; follows the open doc for any moved entry
 * and keeps the Open Files strip's entries in sync (renamed path, or every
 * entry nested under a moved folder).
 */
export async function performMove(paths: string[], destDir: string): Promise<void> {
  const moved: string[] = []
  try {
    for (const src of paths) {
      const p = await moveEntry(src, destDir)
      retargetPath(src, p)
      openList.update((l) => retargetOpen(l, src, p))
      previewPath.update((pv) => retargetPreview(pv, src, p))
      moved.push(p)
    }
  } catch (e) {
    reportError(`Could not move: ${String(e)}`)
  }
  await refreshWorkspace()
  if (moved.length > 0) afterMutation(moved)
}

/**
 * Paste the clipboard into the resolved target directory. Copy mode calls
 * copy_entry; cut mode calls move_entry (and follows the open doc), then clears
 * the clipboard. refreshWorkspace() reconciles the tree with disk afterwards.
 *
 * A cut-paste processes `cb.paths` in order and tracks how many completed
 * successfully. If one fails partway through, the clipboard is repaired to
 * hold only the not-yet-moved items (itself included) instead of either the
 * original full list (which would re-attempt already-moved items and error)
 * or being dropped entirely (which would strand them with no way to retry).
 * Copy-paste is unaffected by a failure: the clipboard already persists
 * copies as-is, so no repair is needed.
 */
export async function paste(): Promise<void> {
  const cb = get(clipboard)
  if (cb === null) return
  const dir = pasteTargetDir(get(focused), folderPaths(get(workspace).tree), get(workspace).root)
  if (dir === null) return
  const results: string[] = []
  let movedCount = 0
  try {
    for (const src of cb.paths) {
      if (cb.mode === 'copy') {
        results.push(await copyEntry(src, dir))
      } else {
        const p = await moveEntry(src, dir)
        retargetPath(src, p)
        openList.update((l) => retargetOpen(l, src, p))
        previewPath.update((pv) => retargetPreview(pv, src, p))
        results.push(p)
        movedCount++
      }
    }
    if (cb.mode === 'cut') clipboard.set(null)
  } catch (e) {
    reportError(`Could not paste: ${String(e)}`)
    if (cb.mode === 'cut') {
      const remaining = cb.paths.slice(movedCount)
      clipboard.set(remaining.length > 0 ? { mode: 'cut', paths: remaining } : null)
    }
  }
  await refreshWorkspace()
  if (results.length > 0) afterMutation(results)
}

/**
 * Move the given paths to the Trash. If the open document (or an ancestor
 * folder of it) is among them, detach it to an unsaved Untitled doc so nothing
 * on screen is lost, and surface an info notice. Also drops any Open Files
 * strip entry that is one of the trashed paths or nested beneath one — a
 * trashed file can't be reopened, so leaving its row behind would just be a
 * dead link. Clears any clipboard entry that referenced a trashed path.
 */
export async function performDelete(paths: string[]): Promise<void> {
  try {
    await deleteEntries(paths)
  } catch (e) {
    reportError(`Could not delete: ${String(e)}`)
    await refreshWorkspace()
    return
  }
  // Decide detachment against the LIVE doc state after the await, not a pre-await
  // snapshot: a doc switch that raced this delete must not detach the wrong
  // document (DEFECT A2). detachIfAffected re-reads state inside doc.update.
  if (detachIfAffected(paths)) {
    reportNotice('This file was moved to Trash — it is now an unsaved document.')
  }
  // Prune readonly memory for every trashed path unconditionally — detach only
  // covers the open doc, so a locked-but-not-open deleted file would otherwise
  // resurrect its stale readonly mark if re-created at the same path (DEFECT A3).
  readonlyMemory.forget(paths)
  openList.update((l) => paths.reduce((acc, p) => removeOpenSubtree(acc, p), l))
  // A previewed file inside any trashed subtree is just as dead as a pinned one.
  previewPath.update((pv) => paths.reduce((acc, p) => clearPreviewInSubtree(acc, p), pv))
  // Drop a clipboard that pointed at anything just trashed.
  const cb = get(clipboard)
  if (cb !== null && cb.paths.some((cp) => paths.some((p) => isSelfOrDescendant(cp, p)))) {
    clipboard.set(null)
  }
  selection.set(new Set())
  focused.set(null)
  await refreshWorkspace()
}
