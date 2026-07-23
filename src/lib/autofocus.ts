import type { Action } from 'svelte/action'

/**
 * Focus (and optionally pre-select) an input the moment it mounts — the single
 * mechanism behind the Quick Open / Go-to-Line bars, the New File/Folder modal,
 * and the workspace-tree inline rename, each of which used to hand-roll a
 * focus-on-mount `$effect` or one-shot action.
 */
export interface AutofocusParam {
  /**
   * How much of the value to pre-select once focused:
   * - `undefined` — focus only (an empty search input has nothing to select).
   * - `null` — `select()` the whole value (rename a folder, name a new one).
   * - `n` — `setSelectionRange(0, n)`: preselect the leading n chars, e.g. a
   *   filename stem so typing replaces the name but keeps its extension.
   */
  selectTo?: number | null
}

/**
 * `use:autofocus` / `use:autofocus={{ selectTo }}`.
 *
 * Applies focus+selection at three (idempotent) moments so it reconstructs
 * every mechanism it replaces without a timing regression:
 *
 * - SYNC, at mount — matches the tree rename row, whose old one-shot action
 *   focused synchronously (the row is already laid out).
 * - MICROTASK — matches the modals' old focus `$effect`. Actions mount
 *   child-first, so this input's sync focus runs BEFORE the sibling
 *   `use:focusTrap` on the panel, which then steals focus to the panel; the
 *   microtask re-focuses right after the mount flush settles (after focusTrap,
 *   after `use:portal` has attached the panel to the body) — the same instant
 *   the old effect ran, with no one-frame window where typing could miss the
 *   input.
 * - rAF — a post-layout backstop for WebKit, where focusTrap's own initial
 *   focus is skipped while the portaled panel is still unlaid-out
 *   (offsetParent null) and a pre-layout `focus()` is dropped.
 */
export const autofocus: Action<HTMLInputElement, AutofocusParam | undefined> = (node, param) => {
  const apply = (): void => {
    node.focus()
    const sel = param?.selectTo
    if (sel === undefined) return
    if (sel === null) node.select()
    else node.setSelectionRange(0, sel)
  }
  apply()
  queueMicrotask(apply)
  const raf = requestAnimationFrame(apply)
  return {
    destroy() {
      cancelAnimationFrame(raf)
    },
  }
}
