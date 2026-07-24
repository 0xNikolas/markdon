/**
 * Keyboard-matcher predicates for the app's CmdOrCtrl chords, plus the shared
 * cmdOrCtrl carve-out helper they route through. Dependency-free (sits next to
 * keymap.ts, its only consumer for the predicates); isMacPlatform reads
 * `navigator` lazily inside the function so there is no module-load side effect.
 */

/**
 * True on Apple platforms. CodeMirror's own selectLine binding is mac-only
 * (`{ key: 'Alt-l', mac: 'Ctrl-l', run: selectLine }` in
 * @codemirror/commands) -- everywhere else Ctrl-L doesn't collide with CM,
 * so only mac needs the metaKey-only carve-out in isGotoLineFallbackKey.
 */
export function isMacPlatform(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const platform = nav?.platform ?? nav?.userAgent ?? ''
  return /Mac|iPhone|iPad|iPod/.test(platform)
}

/**
 * CmdOrCtrl match, with the mac Ctrl carve-out documented once here instead of
 * repeated inline in each predicate.
 *
 * - Non-mac (`mac` false): `metaKey || ctrlKey` — CmdOrCtrl+X IS Ctrl+X, and
 *   there's no metaKey to fall back from.
 * - Mac with the carve-out ON (the default): `metaKey && !ctrlKey` — ctrlKey is
 *   EXCLUDED even alongside metaKey so Ctrl chords stay free for CodeMirror's
 *   emacs-style mac bindings (Ctrl-P cursorLineUp, Ctrl-L selectLine, etc.);
 *   claiming them here would fight CM's own bindings in split mode.
 *
 * Pass `{ macCtrlCarveOut: false }` (or `mac` false) for a combo with no mac
 * special-casing — e.g. Find & Replace, whose Alt-F has no CM binding to
 * collide with, so it matches on `metaKey || ctrlKey` regardless of platform.
 */
export function cmdOrCtrl(
  e: { metaKey: boolean; ctrlKey: boolean },
  mac: boolean,
  opts?: { macCtrlCarveOut?: boolean },
): boolean {
  const carveOut = opts?.macCtrlCarveOut ?? true
  return mac && carveOut ? e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey
}

// -- Go to Line keyboard fallback --------------------------------------------

/**
 * True when `e` is the CmdOrCtrl+L Go to Line keyboard fallback for the given
 * platform. The mac Ctrl carve-out (see cmdOrCtrl) keeps mac Ctrl-L free for
 * CodeMirror's selectLine; off mac, CM's selectLine binds Alt-L, not Ctrl-L,
 * so honoring ctrlKey there is safe (and excluding it would make the fallback
 * unreachable by keyboard on Windows/Linux).
 */
export function isGotoLineFallbackKey(
  e: { metaKey: boolean; ctrlKey: boolean; key: string },
  mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'l') return false
  return cmdOrCtrl(e, mac)
}

// -- Find and Replace keyboard fallback --------------------------------------

/**
 * True when `e` is the CmdOrCtrl+Alt+F Find and Replace keyboard fallback.
 * Checked against `e.code` ('KeyF'), NOT `e.key` -- on macOS, Option
 * (Alt) is a dead-key modifier for typing special characters, so
 * Option+F's `e.key` is 'ƒ' (the florin sign), not 'f'. `e.code` reports
 * the physical key regardless of what character the modifier combination
 * would otherwise type, so it's the only reliable check here. No mac-only
 * carve-out is needed (unlike Go to Line's Cmd+L): CodeMirror's default
 * keymap has no Alt-f binding to collide with, so this matches on
 * `metaKey || ctrlKey` on every platform (cmdOrCtrl with mac=false).
 */
export function isFindReplaceFallbackKey(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string },
): boolean {
  return cmdOrCtrl(e, false) && e.altKey && e.code === 'KeyF'
}

// -- Quick Open keyboard fallback ---------------------------------------------

/**
 * True when `e` is the CmdOrCtrl+P Quick Open keyboard fallback for the given
 * platform. The mac Ctrl carve-out (see cmdOrCtrl) keeps mac Ctrl-P free for
 * CodeMirror's cursorLineUp; off mac CmdOrCtrl+P IS Ctrl+P and CM has no
 * non-mac Ctrl-P binding, so ctrlKey is honored there. Shift and Alt must be
 * UP: Cmd+Shift+P is reserved (VS Code's command palette; shortcuts.ts pencils
 * it in for split-preview), and a looser check would swallow it.
 */
export function isQuickOpenKey(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'p' || e.altKey || e.shiftKey) return false
  return cmdOrCtrl(e, mac)
}

// -- Open-file cycling keys ----------------------------------------------------

/**
 * The file-cycling direction `e` asks for, or null when `e` is not a cycling
 * combo. Two families, both VS Code's standard bindings:
 *
 * - Ctrl+Tab (+1) / Ctrl+Shift+Tab (-1) on EVERY platform — physical Ctrl,
 *   never Cmd (Cmd+Tab is the macOS app switcher and can't reach the webview
 *   anyway). Alt and Meta must be up so browser/OS chords don't leak in.
 * - CmdOrCtrl+Shift+] (+1) / CmdOrCtrl+Shift+[ (-1) — the CmdOrCtrl match runs
 *   through cmdOrCtrl (same mac Ctrl carve-out as Quick Open / Go to Line).
 *   Checked against `e.code` ('BracketRight'/'BracketLeft'), not `e.key`: Shift
 *   remaps the bracket characters ('}'/'{' on US layouts, other glyphs
 *   elsewhere), while the physical key is stable — the same rationale as
 *   isFindReplaceFallbackKey's KeyF check.
 */
export function fileCycleDirection(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string; code: string },
  mac: boolean,
): 1 | -1 | null {
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? -1 : 1
  if (e.shiftKey && !e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
    if (cmdOrCtrl(e, mac)) return e.code === 'BracketRight' ? 1 : -1
  }
  return null
}

/**
 * True when `e` is the CmdOrCtrl+Shift+T Reopen Closed File combo (VS Code /
 * browser standard). Shift must be DOWN and Alt up; the CmdOrCtrl match runs
 * through cmdOrCtrl (same mac Ctrl carve-out as Quick Open / Go to Line).
 * `e.key` is safe here (unlike the bracket chords): Shift+T reports 'T', which
 * lowercases cleanly.
 */
export function isReopenClosedKey(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== 't' || !e.shiftKey || e.altKey) return false
  return cmdOrCtrl(e, mac)
}
