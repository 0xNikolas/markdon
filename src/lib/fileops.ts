import { invoke } from '@tauri-apps/api/core'
import { get, writable, type Writable } from 'svelte/store'
import { doc, retargetPath, detachToUntitled } from './doc'
import { reportError, reportNotice } from './errors'
import { workspace, refreshWorkspace, type WorkspaceDir } from './workspace'
import { openList, retargetOpen, removeOpenSubtree } from './openList'

/**
 * Sidebar file-operations state and the app-internal file clipboard, plus the
 * command wrappers that drive the Rust file-ops backend. The backend re-derives
 * all trust from the allowlist, so these paths are UI convenience only — never a
 * security boundary.
 */

/** Currently selected row paths (files or folders). Cut/Copy/Delete act on this. */
export const selection: Writable<Set<string>> = writable(new Set())

/** The focused row — the anchor for Paste's target and single-select ops. */
export const focused: Writable<string | null> = writable(null)

export interface Clipboard {
  mode: 'cut' | 'copy'
  paths: string[]
}

/** App-internal file clipboard. `null` disables Paste. */
export const clipboard: Writable<Clipboard | null> = writable(null)

/**
 * Reset selection/focus/clipboard. Every path they hold is only meaningful
 * inside the workspace it was captured in, so a switch to a different root
 * (Open Folder, or the launch-time restore) must drop them — otherwise a Cut
 * from the old workspace can be Pasted into the new one, silently moving a
 * file across workspaces, and a stale `focused` misdirects New File.
 */
export function clearFileOpsState(): void {
  selection.set(new Set())
  focused.set(null)
  clipboard.set(null)
}

// Clear file-ops state whenever the open workspace's root changes — including
// the very first adopt (openWorkspace, refreshWorkspace, restoreWorkspace all
// funnel through `workspace.set` in workspace.ts's `adopt`). A same-root
// update (e.g. refreshWorkspace re-walking the tree) must NOT clear, so the
// selection survives an ordinary refresh.
let lastRoot: string | null = get(workspace).root
workspace.subscribe((s) => {
  if (s.root === lastRoot) return
  lastRoot = s.root
  clearFileOpsState()
})

// -- pure helpers (unit-tested) ----------------------------------------------

/**
 * Paths of every currently-visible row, in display order: a folder's children
 * are included only when the folder is expanded (absent/false in `collapsed`).
 * The root node itself is not a row. Used for Select All so it honors what the
 * user can actually see.
 */
export function visibleRowPaths(
  tree: WorkspaceDir | null,
  collapsed: Record<string, boolean>,
): string[] {
  if (tree === null) return []
  const out: string[] = []
  const walk = (d: WorkspaceDir): void => {
    for (const sub of d.dirs) {
      out.push(sub.path)
      if (!collapsed[sub.path]) walk(sub)
    }
    for (const f of d.files) out.push(f.path)
  }
  walk(tree)
  return out
}

export interface FolderRow {
  path: string
  label: string
  depth: number
}

/**
 * Flatten the tree into the workspace root plus every folder, in display order,
 * for the Move-to picker. The root is depth 0; nested folders indent from there.
 */
export function folderRows(tree: WorkspaceDir | null): FolderRow[] {
  if (tree === null) return []
  const rows: FolderRow[] = [{ path: tree.path, label: tree.name, depth: 0 }]
  const walk = (d: WorkspaceDir, depth: number): void => {
    for (const sub of d.dirs) {
      rows.push({ path: sub.path, label: sub.name, depth })
      walk(sub, depth + 1)
    }
  }
  walk(tree, 1)
  return rows
}

/** All directory paths in the tree, including the root — the set of valid paste targets. */
export function folderPaths(tree: WorkspaceDir | null): Set<string> {
  const set = new Set<string>()
  if (tree === null) return set
  set.add(tree.path)
  const walk = (d: WorkspaceDir): void => {
    for (const sub of d.dirs) {
      set.add(sub.path)
      walk(sub)
    }
  }
  walk(tree)
  return set
}

/**
 * Resolve the directory a Paste lands in: the focused folder if a folder is
 * focused; otherwise the focused file's parent; otherwise the workspace root.
 * Returns `null` only when nothing sensible is available.
 */
export function pasteTargetDir(
  focusedPath: string | null,
  folderSet: Set<string>,
  root: string | null,
): string | null {
  if (focusedPath === null) return root
  if (folderSet.has(focusedPath)) return focusedPath
  const parent = focusedPath.split('/').slice(0, -1).join('/')
  return parent || root
}

/** True when `child` is `ancestor` itself or nested beneath it (segment-safe). */
export function isSelfOrDescendant(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + '/')
}

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

// -- selection / clipboard mutators -------------------------------------------

/** Single-select a row and make it the focus anchor. */
export function focusRow(path: string): void {
  focused.set(path)
  selection.set(new Set([path]))
}

/** Deselect everything: empty-space click in the sidebar (spec 2026-07-21). */
export function clearSelection(): void {
  selection.set(new Set())
  focused.set(null)
}

/** Snapshot the current selection into the clipboard as a cut or copy. */
export function cutSelection(): void {
  const paths = [...get(selection)]
  if (paths.length > 0) clipboard.set({ mode: 'cut', paths })
}
export function copySelection(): void {
  const paths = [...get(selection)]
  if (paths.length > 0) clipboard.set({ mode: 'copy', paths })
}

/** Select every visible row (Select All). */
export function selectVisible(tree: WorkspaceDir | null, collapsed: Record<string, boolean>): void {
  selection.set(new Set(visibleRowPaths(tree, collapsed)))
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
  const openPath = get(doc).path
  try {
    await deleteEntries(paths)
  } catch (e) {
    reportError(`Could not delete: ${String(e)}`)
    await refreshWorkspace()
    return
  }
  if (openPath !== null && paths.some((p) => isSelfOrDescendant(openPath, p))) {
    detachToUntitled()
    reportNotice('This file was moved to Trash — it is now an unsaved document.')
  }
  openList.update((l) => paths.reduce((acc, p) => removeOpenSubtree(acc, p), l))
  // Drop a clipboard that pointed at anything just trashed.
  const cb = get(clipboard)
  if (cb !== null && cb.paths.some((cp) => paths.some((p) => isSelfOrDescendant(cp, p)))) {
    clipboard.set(null)
  }
  selection.set(new Set())
  focused.set(null)
  await refreshWorkspace()
}
