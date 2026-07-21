/**
 * The structural slice of a DOM element this module reads. Real `HTMLElement`s
 * satisfy it as-is; tests (node environment, no jsdom) pass plain objects.
 * `isContentEditable` is the browser-computed EFFECTIVE editability — it
 * follows contenteditable inheritance, so an explicit contenteditable="false"
 * island inside the editor reports false.
 */
export interface ContextMenuTarget {
  tagName?: unknown
  isContentEditable?: unknown
}

/**
 * Whether a right-click on `target` should get the platform's native context
 * menu. Everywhere else it is suppressed: outside editable text, WKWebView's
 * default menu offers only "Reload", which reloads the whole webview and wipes
 * every in-memory store — the Open Files list, the unsaved buffer, find state.
 * A user right-clicking a sidebar row and picking the only visible option was
 * silently losing their session (the bug this guards against).
 *
 * Editable surfaces keep the native menu: the Crepe editor (contenteditable)
 * and form fields rely on it for copy/paste/spellcheck.
 */
export function allowsNativeContextMenu(target: ContextMenuTarget | null | undefined): boolean {
  if (!target || typeof target.tagName !== 'string') return false // non-element (window, text node, null)
  if (target.isContentEditable === true) return true
  const tag = target.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA'
}
