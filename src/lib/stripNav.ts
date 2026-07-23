/**
 * Pure keyboard-navigation decisions for the Open Files strip — the flat-list
 * sibling of treeNav.ts (same pattern: pure intent, thin component wiring).
 * The strip is a VERTICAL list of rows, so ArrowUp/ArrowDown move between
 * rows and Home/End jump to the ends, all clamped (never wrapping — wrapping
 * is Ctrl+Tab's job, see openList.neighbourInStrip). Enter/Space need no
 * intent: rows are real <button>s, so native activation fires their existing
 * click handlers (switch/preview), which is also why the strip keeps
 * role=button rows with a roving tabindex instead of switching to
 * listbox/option — the e2e locator contract (getByRole('button', name)) and
 * the two-sibling-buttons row structure (row + its close affordance) both
 * predate this feature, and a flat list of buttons is valid a11y.
 */

export type StripKeyIntent = { kind: 'focus'; index: number } | null

/**
 * @param key      KeyboardEvent.key
 * @param focused  index of the currently-focused row, -1 when focus is not on
 *                 a strip row (land on the first/last row, like treeNav)
 * @param rowCount visible strip rows (pinned + the preview row when showing)
 */
export function stripKeyIntent(key: string, focused: number, rowCount: number): StripKeyIntent {
  if (rowCount === 0) return null
  switch (key) {
    case 'ArrowDown': {
      const next = focused === -1 ? 0 : Math.min(focused + 1, rowCount - 1)
      return next === focused ? null : { kind: 'focus', index: next }
    }
    case 'ArrowUp': {
      const prev = focused === -1 ? rowCount - 1 : Math.max(focused - 1, 0)
      return prev === focused ? null : { kind: 'focus', index: prev }
    }
    case 'Home':
      return focused === 0 ? null : { kind: 'focus', index: 0 }
    case 'End': {
      const last = rowCount - 1
      return focused === last ? null : { kind: 'focus', index: last }
    }
    default:
      return null
  }
}
