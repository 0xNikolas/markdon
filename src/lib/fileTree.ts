import type { WorkspaceDir } from './workspace'
import { dirname } from './paths'

/**
 * Pure workspace-tree and name helpers for the sidebar's file operations:
 * name validation, visible-row flattening, folder enumeration, and paste-
 * target resolution. No stores, no IPC — everything here is a pure function
 * (workspace.ts contributes only the WorkspaceDir type), so the modals
 * (NameModal, MoveToModal) can depend on this module alone.
 */

/**
 * Validate a single path segment for New File / New Folder / inline rename —
 * mirrors the backend's valid_leaf_name gate so the user gets immediate
 * feedback rather than a round-trip error banner. Returns a user-facing
 * message, or `null` when the name is acceptable.
 */
export function leafNameError(name: string): string | null {
  if (name.trim() === '') return 'Name cannot be empty'
  if (name === '.' || name === '..') return `"${name}" is not a valid name`
  if (name.includes('/') || name.includes('\\')) return 'Name cannot contain "/" or "\\"'
  return null
}

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
  const parent = dirname(focusedPath)
  return parent || root
}
