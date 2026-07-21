/**
 * Svelte action that relocates `node` to `document.body` for its lifetime.
 *
 * Modals opened from deep in the tree (e.g. the sidebar file-ops modals) must
 * not render inside `main.app`: `focusTrap` marks `main.app` `inert`, and a
 * modal nested under it would inherit that inertness and become unclickable.
 * Portaling to `<body>` — a sibling of `main.app`, exactly where App.svelte's
 * own modals live — keeps the modal interactive while the rest of the app is
 * inert. On destroy the node is removed from the body.
 */
export function portal(node: HTMLElement): { destroy(): void } {
  document.body.appendChild(node)
  return {
    destroy() {
      node.remove()
    },
  }
}
