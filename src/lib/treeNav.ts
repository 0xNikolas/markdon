/**
 * Pure keyboard-navigation decisions for the workspace tree (ARIA tree
 * pattern, https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): given the
 * pressed key and the current row state, return the single intent the tree
 * component should apply — move focus, expand, or collapse. No stores, no
 * DOM — WorkspaceTree owns wiring intents to focusRow/collapsed.
 *
 * Key mapping (all clamped, never wrapping):
 *   ArrowDown / ArrowUp  next / previous visible row; with no focused row,
 *                        land on the first / last row.
 *   ArrowRight           collapsed folder → expand; expanded folder → focus
 *                        its first child; file (or childless folder) → none.
 *   ArrowLeft            expanded folder → collapse; otherwise → focus the
 *                        parent folder row (none for root-level rows — the
 *                        workspace root is not a row).
 *   Home / End           first / last visible row.
 *
 * Enter on a file returns an explicit `open` intent (pin, the dblclick
 * analogue): previewing via Space and then editing relies on promote-on-edit,
 * so the keyboard needs a direct "really open" action. Space stays absent —
 * rows are real <button>s, so native Space activation fires their click
 * handlers (file preview / folder toggle), as does Enter on a folder.
 */

export type TreeKeyIntent =
  | { kind: 'focus'; path: string }
  | { kind: 'expand'; path: string }
  | { kind: 'collapse'; path: string }
  | { kind: 'open'; path: string }
  | null

/**
 * @param key         KeyboardEvent.key
 * @param focusedPath the focus anchor (fileOpsState `focused`); a path that is
 *                    not currently visible counts as no focus
 * @param visible     visibleRowPaths(tree, collapsed) — display order
 * @param folders     folderPaths(tree) — which paths are directories
 * @param collapsed   the collapse map (absent/false = expanded)
 */
export function treeKeyIntent(
  key: string,
  focusedPath: string | null,
  visible: readonly string[],
  folders: ReadonlySet<string>,
  collapsed: Record<string, boolean>,
): TreeKeyIntent {
  if (visible.length === 0) return null
  const idx = focusedPath === null ? -1 : visible.indexOf(focusedPath)

  switch (key) {
    case 'ArrowDown': {
      const next = idx === -1 ? 0 : Math.min(idx + 1, visible.length - 1)
      return next === idx ? null : { kind: 'focus', path: visible[next] }
    }
    case 'ArrowUp': {
      const prev = idx === -1 ? visible.length - 1 : Math.max(idx - 1, 0)
      return prev === idx ? null : { kind: 'focus', path: visible[prev] }
    }
    case 'ArrowRight': {
      if (idx === -1) return null
      const path = visible[idx]
      if (!folders.has(path)) return null
      if (collapsed[path]) return { kind: 'expand', path }
      // Expanded: the first child is the next visible row — but only when it
      // actually IS a child (an empty expanded folder is followed by a
      // sibling, and Right must not jump to it).
      const next = visible[idx + 1]
      return next !== undefined && next.startsWith(path + '/')
        ? { kind: 'focus', path: next }
        : null
    }
    case 'ArrowLeft': {
      if (idx === -1) return null
      const path = visible[idx]
      if (folders.has(path) && !collapsed[path]) return { kind: 'collapse', path }
      const parent = path.slice(0, path.lastIndexOf('/'))
      return visible.includes(parent) ? { kind: 'focus', path: parent } : null
    }
    case 'Home':
      return idx === 0 ? null : { kind: 'focus', path: visible[0] }
    case 'End': {
      const last = visible.length - 1
      return idx === last ? null : { kind: 'focus', path: visible[last] }
    }
    case 'Enter': {
      // Files get an explicit OPEN intent — the keyboard analogue of a
      // dblclick pin, distinct from Space's native activation (preview).
      // Folders return null so native button activation keeps toggling them.
      if (idx === -1) return null
      const path = visible[idx]
      return folders.has(path) ? null : { kind: 'open', path }
    }
    default:
      return null
  }
}
