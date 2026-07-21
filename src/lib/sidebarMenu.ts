/**
 * Selection rule for right-clicking a workspace-tree row (Finder/VS Code
 * semantics): a target already in the selection keeps the whole selection —
 * right-clicking a multi-selection acts on all of it — while a target outside
 * it becomes the sole selection. Always returns a fresh Set in the replace
 * case so callers can hand it straight to a store.
 */
export function selectionForContextMenu(
  selection: ReadonlySet<string>,
  target: string,
): Set<string> {
  return selection.has(target) ? new Set(selection) : new Set([target])
}

/**
 * Keep a context menu of the given size fully inside the viewport: shift left/
 * up when it would overflow the right/bottom edge, flooring at 0 so an
 * oversized menu pins to the top-left rather than escaping negative.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menu: { w: number; h: number },
  viewport: { w: number; h: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, viewport.w - menu.w)),
    y: Math.max(0, Math.min(y, viewport.h - menu.h)),
  }
}

/**
 * The structural slice of a DOM element the empty-space-deselect check reads
 * (same pattern as contextMenu.ts#allowsNativeContextMenu — pure, node-
 * testable). Real Elements satisfy it via Element.closest.
 */
export interface ClearTarget {
  closest?: unknown
}

/**
 * Whether a pointer press in the side panel should clear the selection: yes
 * only when it landed outside every button. Rows, header controls ("…", New
 * File, Open Folder), and menu items are all <button>s, so anything inside a
 * button either IS the selection or acts on it; bare panel/tree space is not.
 * Non-element targets fail closed (no clearing).
 */
export function isSelectionClearingTarget(target: ClearTarget | null | undefined): boolean {
  if (!target || typeof target.closest !== 'function') return false
  return (target.closest as (sel: string) => unknown)('button') == null
}
