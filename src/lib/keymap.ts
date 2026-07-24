import {
  isGotoLineFallbackKey,
  isFindReplaceFallbackKey,
  isQuickOpenKey,
  fileCycleDirection,
  isReopenClosedKey,
} from './keys'

/**
 * The one declarative shortcut table. It is the SINGLE source of truth for the
 * three surfaces that used to hand-maintain their own copies:
 *
 *  (a) the window keydown handler — App's driver runs {@link matchKeydown}
 *      (first match wins, in KEYMAP array order), then applies the matched
 *      entry's `keydownGuard` and `preventDefault` mode before invoking the
 *      matching action closure (kept in App because it closes over the doc /
 *      openList / overlay stores);
 *  (b) menu-event routing — App subscribes `menu:<id>` for every entry whose
 *      `hasMenuItem` is set and routes it to the same-id action closure;
 *  (c) the Settings > Shortcuts list — {@link settingsList} returns the
 *      `showInSettings` rows in `settingsOrder`, rendered as <kbd> by
 *      SettingsModal.
 *
 * DATA vs BEHAVIOR: this table holds only the pure, testable DATA (id, display
 * label/keys, the pure keydown `match` predicate, and the guard/preventDefault
 * flags). The action closures live in App.svelte keyed by the same `id` — they
 * must, because they close over App's stores and helpers (guarded, routeFind,
 * toggleReadonly, …). The two are joined by `id`.
 *
 * TWO ORDERINGS, one array: the KEYMAP array is ordered for KEYDOWN MATCHING —
 * the order is load-bearing (find_replace MUST precede find, so Cmd+Alt+F is
 * claimed as Find-and-Replace and never leaks to the looser Find matcher on
 * platforms where Option doesn't remap `e.key`). The Settings DISPLAY order is
 * expressed separately via each row's `settingsOrder`, so the two orderings
 * stay independent without duplicating any row.
 *
 * `keys[]` are DISPLAY strings mirroring src-tauri/src/menu.rs accelerators;
 * they are deliberately decoupled from the `match` predicates (which encode the
 * real e.code-vs-e.key and platform carve-outs). Do NOT derive one from the
 * other — they are two representations of the same binding, mirroring menu.rs.
 */

/** One read-only Settings > Shortcuts row (label + note + <kbd> keys). */
export interface Shortcut {
  label: string
  keys: string[]
  /** Optional one-liner clarifying what the action does (shown muted). */
  note?: string
}

/**
 * The structural shape both the real DOM KeyboardEvent and the pure ui.ts
 * predicates share. Using the structural type (not lib.dom's KeyboardEvent)
 * keeps {@link KeyBinding.match} callable from unit tests with plain literals.
 */
export type KeyEventLike = {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
  code: string
}

/**
 * How the window keydown driver gates and preventDefaults a matched binding.
 * Each value names the exact live-state condition the original if-chain used:
 *  - 'overlay'       — run only when no overlay is open (quick_open, reopen).
 *  - 'overlay-empty' — run only when no overlay is open AND not the empty page
 *                      (file cycling, find-replace, go-to-line).
 *  - 'empty'         — run only when not the empty page (Find; it has no
 *                      overlay gate — it deliberately claims Cmd/Ctrl+F even
 *                      while other surfaces are up, matching the original).
 */
export type KeydownGuard = 'overlay' | 'overlay-empty' | 'empty'

export interface KeyBinding {
  id: string
  /** Settings-panel label, or null for menu/keyboard-only rows not shown there. */
  label: string | null
  /** Display keys mirroring the menu.rs accelerator / combo; decoupled from match. */
  keys: string[]
  note?: string
  /** True → App subscribes `menu:<id>` and routes it to the same-id action. */
  hasMenuItem: boolean
  /** True → the row appears in the Settings Shortcuts list at `settingsOrder`. */
  showInSettings: boolean
  /** Display position in the Settings list (only meaningful when showInSettings). */
  settingsOrder?: number
  /**
   * Pure keydown matcher (event + mac flag). Absent → the binding has no JS
   * keyboard fallback (its accelerator is handled natively by the Rust menu),
   * so it participates only as a menu route and/or a Settings display row.
   */
  match?: (e: KeyEventLike, mac: boolean) => boolean
  /** Guard the driver applies before running a matched keydown binding. */
  keydownGuard?: KeydownGuard
  /**
   * When the driver calls preventDefault relative to the guard:
   *  - 'always' — BEFORE the guard check, so the combo is claimed even when the
   *    action no-ops (Cmd/Ctrl+P, Ctrl+Tab, Cmd+Shift+T / brackets must never
   *    leak to the webview's print/focus-traversal/reopen defaults).
   *  - 'onRun'  — only AFTER the guard passes (return WITHOUT preventDefault
   *    when gated out), matching the original find-replace / find / go-to-line
   *    branches.
   */
  preventDefault?: 'always' | 'onRun'
}

/**
 * The table. Array order = keydown MATCH priority (first match wins). Entries
 * with a `match` come first, in the exact order of the original if-chain
 * (quick_open, reopen_closed, file cycle, find_replace, find, goto_line); the
 * menu-only and Settings-display-only rows follow (their order is irrelevant to
 * matching). Settings DISPLAY order is `settingsOrder`, not array position.
 */
export const KEYMAP: KeyBinding[] = [
  // -- keyboard-matched bindings, in load-bearing match order ----------------
  {
    id: 'quick_open',
    label: 'Quick Open…',
    keys: ['Cmd', 'P'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 3,
    match: (e, mac) => isQuickOpenKey(e, mac),
    keydownGuard: 'overlay',
    preventDefault: 'always',
  },
  {
    id: 'reopen_closed',
    label: 'Reopen Closed File',
    keys: ['Cmd', 'Shift', 'T'],
    note: 'Restores the most recently closed Open Files entry at its old position.',
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 6,
    match: (e, mac) => isReopenClosedKey(e, mac),
    keydownGuard: 'overlay',
    preventDefault: 'always',
  },
  {
    id: 'file_cycle_next',
    label: 'Next Open File',
    keys: ['Cmd', 'Shift', ']'],
    note: 'Cycles the Open Files strip in row order, wrapping. Ctrl+Tab also works.',
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 4,
    match: (e, mac) => fileCycleDirection(e, mac) === 1,
    keydownGuard: 'overlay-empty',
    preventDefault: 'always',
  },
  {
    id: 'file_cycle_prev',
    label: 'Previous Open File',
    keys: ['Cmd', 'Shift', '['],
    note: 'Same cycle, backwards. Ctrl+Shift+Tab also works.',
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 5,
    match: (e, mac) => fileCycleDirection(e, mac) === -1,
    keydownGuard: 'overlay-empty',
    preventDefault: 'always',
  },
  {
    // Checked BEFORE find: on non-mac Cmd+Alt+F reports e.key 'f' and would
    // also satisfy find's looser test, so find-replace must win the match.
    id: 'find_replace',
    label: 'Find and Replace…',
    keys: ['Cmd', 'Alt', 'F'],
    note: 'WYSIWYG opens the find bar with the replace row expanded; split mode uses the CodeMirror native panel.',
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 11,
    match: (e) => isFindReplaceFallbackKey(e),
    keydownGuard: 'overlay-empty',
    preventDefault: 'onRun',
  },
  {
    // No mac Ctrl carve-out and no overlay gate — the original Find branch is
    // literally `(metaKey||ctrlKey) && key==='f'`, claiming Cmd/Ctrl+F on every
    // platform. Preserve it verbatim.
    id: 'find',
    label: 'Find',
    keys: ['Cmd', 'F'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 10,
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f',
    keydownGuard: 'empty',
    preventDefault: 'onRun',
  },
  {
    id: 'goto_line',
    label: 'Go to Line…',
    keys: ['Cmd', 'L'],
    note: 'Accepts a line, or line:col (col is 0-based, matching the status bar).',
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 12,
    match: (e, mac) => isGotoLineFallbackKey(e, mac),
    keydownGuard: 'overlay-empty',
    preventDefault: 'onRun',
  },

  // -- menu + Settings rows with no JS keyboard fallback ---------------------
  // (their accelerators are handled natively by the Rust menu)
  {
    id: 'new',
    label: 'New File',
    keys: ['Cmd', 'N'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 1,
  },
  {
    id: 'open',
    label: 'Open…',
    keys: ['Cmd', 'O'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 2,
  },
  {
    id: 'save',
    label: 'Save',
    keys: ['Cmd', 'S'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 7,
  },
  {
    id: 'save_as',
    label: 'Save As…',
    keys: ['Cmd', 'Shift', 'S'],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 8,
  },
  {
    id: 'export',
    label: 'Export…',
    keys: ['Cmd', 'Shift', 'E'],
    note: 'Exports the current format; PDF opens the macOS print dialog (Save as PDF).',
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 9,
  },
  {
    id: 'history',
    label: 'File History…',
    keys: ['Cmd', 'Shift', 'H'],
    note: 'View and revert to previous saved versions; revert loads as unsaved changes.',
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 13,
  },
  {
    id: 'settings',
    label: 'Settings',
    keys: ['Cmd', ','],
    hasMenuItem: true,
    showInSettings: true,
    settingsOrder: 14,
  },

  // -- menu-only rows (no keyboard fallback, not shown in Settings) ----------
  {
    id: 'toggle_readonly',
    label: null,
    keys: [],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'open_folder',
    label: null,
    keys: ['Cmd', 'Shift', 'O'],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'close_folder',
    label: null,
    keys: [],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'open_recent',
    label: null,
    keys: [],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'show_log',
    label: null,
    keys: [],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'close_tab',
    label: null,
    keys: ['Cmd', 'W'],
    hasMenuItem: true,
    showInSettings: false,
  },
  {
    id: 'close_window',
    label: null,
    keys: ['Cmd', 'Shift', 'W'],
    hasMenuItem: true,
    showInSettings: false,
  },

  // -- Settings display-only rows (native Edit menu; no menu:<id>, no match) --
  {
    id: 'undo',
    label: 'Undo',
    keys: ['Cmd', 'Z'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 15,
  },
  {
    id: 'redo',
    label: 'Redo',
    keys: ['Cmd', 'Shift', 'Z'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 16,
  },
  {
    id: 'cut',
    label: 'Cut',
    keys: ['Cmd', 'X'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 17,
  },
  {
    id: 'copy',
    label: 'Copy',
    keys: ['Cmd', 'C'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 18,
  },
  {
    id: 'paste',
    label: 'Paste',
    keys: ['Cmd', 'V'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 19,
  },
  {
    id: 'select_all',
    label: 'Select All',
    keys: ['Cmd', 'A'],
    hasMenuItem: false,
    showInSettings: true,
    settingsOrder: 20,
  },
]

/**
 * First keydown binding whose pure `match` accepts `e`, or null. Iterates
 * KEYMAP in array order — first match wins — so the load-bearing ordering
 * (find_replace before find) is honored. Returns just the `id`; the driver
 * looks up guard/preventDefault/action from there.
 */
export function matchKeydown(e: KeyEventLike, mac: boolean): KeyBinding | null {
  for (const b of KEYMAP) {
    if (b.match?.(e, mac)) return b
  }
  return null
}

/** Look up a binding by id (used by App's keydown driver and menu wiring). */
export function bindingById(id: string): KeyBinding | undefined {
  return KEYMAP.find((b) => b.id === id)
}

/** Every id that emits a `menu:<id>` event (drives App's menu subscription). */
export function menuItemIds(): string[] {
  return KEYMAP.filter((b) => b.hasMenuItem).map((b) => b.id)
}

/**
 * The Settings > Shortcuts rows, in display order — the single replacement for
 * the old hand-written APP_SHORTCUTS array. Sorted by `settingsOrder` so the
 * table's keydown-match array order doesn't leak into the panel.
 */
export function settingsList(): Shortcut[] {
  return KEYMAP.filter((b) => b.showInSettings)
    .slice()
    .sort((a, b) => (a.settingsOrder ?? 0) - (b.settingsOrder ?? 0))
    .map((b) => {
      const row: Shortcut = { label: b.label ?? '', keys: b.keys }
      if (b.note !== undefined) row.note = b.note
      return row
    })
}
