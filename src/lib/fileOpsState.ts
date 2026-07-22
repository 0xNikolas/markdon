import { get, writable, type Writable } from 'svelte/store'
import { workspace, type WorkspaceDir } from './workspace'
import { visibleRowPaths } from './fileTree'

/**
 * Sidebar file-operations UI state: the row selection/focus anchor and the
 * app-internal file clipboard, plus their mutators. Selection and clipboard
 * live together deliberately — cutSelection/copySelection read the selection
 * and write the clipboard, and clearFileOpsState resets all three, so
 * separating them would only create an import cycle.
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
