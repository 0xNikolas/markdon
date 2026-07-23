import { get, writable, type Writable } from 'svelte/store'
import { workspace } from './workspace'
import { ancestorDirs, basename as pathBasename, splitExt } from './paths'
import { leafNameError } from './fileTree'

/**
 * Workspace-tree row UI state: folder collapse and the inline rename slot.
 * Module stores (the fileOpsState.ts precedent) so the tree component and the
 * sidebar's header/context menus share them via imports rather than closure —
 * the FileOpsMenu "Rename…" action arms a rename that WorkspaceTree renders.
 */

/** Collapse state keyed by dir path. Absent/false = expanded. */
export const collapsed: Writable<Record<string, boolean>> = writable({})

export function toggleFolder(path: string): void {
  collapsed.update((c) => ({ ...c, [path]: !c[path] }))
}

/**
 * Set a folder's collapse state explicitly — keyboard Left/Right on the tree,
 * where the treeKeyIntent decision already knows the target state and a
 * toggle could race a click on the same chevron.
 */
export function setFolderCollapsed(path: string, value: boolean): void {
  collapsed.update((c) => ({ ...c, [path]: value }))
}

/**
 * Inline rename (VS Code style — no modal): the row whose name is being
 * edited plus the live input value. One rename at a time; NameModal stays
 * for New File / New Folder only.
 */
export const renaming: Writable<string | null> = writable(null)
export const renameValue: Writable<string> = writable('')

export function basename(path: string): string {
  return pathBasename(path) || path
}

/** The offset of the extension dot, so a rename preselects just the stem. */
export function stemLength(name: string): number {
  return splitExt(name).stem.length
}

/**
 * Arm the inline rename for `path`, expanding every collapsed ancestor first
 * (VS Code behavior): the rename input only exists for VISIBLE rows, so
 * arming a hidden one would leave an input that mounts later, steals focus,
 * and can commit stale.
 */
export function startRename(path: string): void {
  const root = get(workspace).root
  if (root !== null) {
    collapsed.update((c) => {
      const next = { ...c }
      for (const dir of ancestorDirs(root, path)) next[dir] = false
      return next
    })
  }
  renameValue.set(basename(path))
  renaming.set(path)
}

export function cancelRename(): void {
  renaming.set(null)
  renameValue.set('')
}

export type RenameOutcome =
  | { kind: 'skip' }
  | { kind: 'cancel' }
  | { kind: 'commit'; newName: string }

/**
 * The pure decision behind committing an inline rename. `skip` when `path`
 * isn't the armed row (the input's teardown blur after Enter/Escape already
 * resolved it — the gate that makes commit idempotent); `cancel` on an
 * unchanged or invalid name (VS Code drops the edit silently; the input's red
 * border already gave live feedback); else `commit` with the trimmed name.
 */
export function renameCommit(armed: string | null, path: string, value: string): RenameOutcome {
  if (armed !== path) return { kind: 'skip' }
  const next = value.trim()
  if (next === basename(path) || leafNameError(next) !== null) return { kind: 'cancel' }
  return { kind: 'commit', newName: next }
}

// A workspace switch invalidates any in-flight rename — the armed path
// belongs to the OLD tree, and its input could otherwise mount against an
// unrelated same-named row later. Tracked against the ROOT only: refreshes
// of the same folder (refocus, file ops) must not cancel the user's typing.
// Module-level subscription (not a component effect) so it stays armed even
// while no tree is mounted — e.g. across a Close Folder / Open Folder cycle.
let renameRoot: string | null = get(workspace).root
workspace.subscribe((s) => {
  if (s.root === renameRoot) return
  renameRoot = s.root
  renaming.set(null)
})
