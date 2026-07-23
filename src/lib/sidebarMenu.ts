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
 * The single tree-row the file-level context-menu actions target: exactly one
 * NON-FOLDER selection, tagged with the type + open-state the gating reads.
 * `isFile` is false for a folder, a multi-selection, or an empty selection —
 * none of the file actions apply then.
 */
export interface FileMenuTarget {
  /** A single, non-folder selection — the precondition for every file action. */
  isFile: boolean
  isMarkdown: boolean
  isImage: boolean
  /** Currently listed in the Open Files strip (pinned OR the preview row). */
  isOpen: boolean
}

/** Which of the row menu's file-level actions to SHOW for a {@link FileMenuTarget}. */
export interface FileMenuVisibility {
  open: boolean
  reveal: boolean
  copyPath: boolean
  close: boolean
}

/**
 * Gate the tree row context menu's file-level actions by file type + open
 * state (the only place this decision lives — the FileOpsMenu items array and
 * its tests both read it):
 *   - Open        — only an OPENABLE file (markdown → current tab, image →
 *                   image view); hidden for any other type.
 *   - Reveal /    — any single file regardless of type or open state (Finder
 *     Copy Path     reveal + clipboard both work for a merely-listed file).
 *   - Close       — only when the file is currently in the Open Files strip.
 * All four require a single non-folder selection, so a folder, a multi-select,
 * or an empty selection yields all-false (nothing to act on).
 */
export function fileMenuVisibility(t: FileMenuTarget): FileMenuVisibility {
  if (!t.isFile) return { open: false, reveal: false, copyPath: false, close: false }
  return {
    open: t.isMarkdown || t.isImage,
    reveal: true,
    copyPath: true,
    close: t.isOpen,
  }
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
 * The inline-rename input is the one interactive row element that is NOT a
 * button (an input inside a button is invalid HTML, so the renaming row swaps
 * to a div) — match it explicitly, or clicking to place the caret would wipe
 * the selection under the rename. Non-element targets fail closed (no
 * clearing).
 */
export function isSelectionClearingTarget(target: ClearTarget | null | undefined): boolean {
  if (!target || typeof target.closest !== 'function') return false
  return (target.closest as (sel: string) => unknown)('button, .rename-input') == null
}
