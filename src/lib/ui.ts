import { writable, type Writable } from 'svelte/store'

/**
 * Shell contract module: the stores the app chrome (Header/StatusBar) renders
 * from, filled in by later features. Single source of truth — split-preview,
 * settings, export and workspace import from here rather than defining their
 * own copies.
 */

/** File-watch state shown in the status bar. Set by fileSync.ts. */
export type WatchStatus = 'watching' | 'idle'
export const watchStatus: Writable<WatchStatus> = writable('idle')

/**
 * Cursor position for the status bar's Ln/Col segment.
 * `line` is 1-based, `col` is 0-based (matches the design literals
 * "Ln 14, Col 42" and "Ln 1, Col 0"; CM's natural offset). null hides the
 * segment — WYSIWYG mode sets nothing; split mode's CodeMirror feeds it.
 */
export interface CursorPos {
  line: number
  col: number
}
export const cursor: Writable<CursorPos | null> = writable(null)

const SPLIT_KEY = 'markdon.split'

/** Parse the persisted split flag; anything but the string 'true' is false. */
export function parseSplit(raw: string | null): boolean {
  return raw === 'true'
}

function loadSplit(): boolean {
  try {
    return parseSplit(globalThis.localStorage?.getItem(SPLIT_KEY) ?? null)
  } catch {
    return false
  }
}

/** Split-preview mode, persisted across launches. Consumed by split-preview. */
export const split: Writable<boolean> = writable(loadSplit())

export function toggleSplit(): void {
  split.update((v) => {
    const next = !v
    try {
      globalThis.localStorage?.setItem(SPLIT_KEY, String(next))
    } catch {
      /* storage unavailable: still toggle in-memory */
    }
    return next
  })
}

/** Settings modal visibility. The settings feature renders from this flag. */
export const settingsOpen: Writable<boolean> = writable(false)
export function openSettings(): void {
  settingsOpen.set(true)
}
export function closeSettings(): void {
  settingsOpen.set(false)
}

/** Go to Line popover visibility. Mirrors settingsOpen/openSettings/closeSettings. */
export const gotoOpen: Writable<boolean> = writable(false)
export function openGoto(): void {
  gotoOpen.set(true)
}
export function closeGoto(): void {
  gotoOpen.set(false)
}

/** File History modal visibility. Mirrors settingsOpen/openSettings/closeSettings. */
export const historyOpen: Writable<boolean> = writable(false)
export function openHistory(): void {
  historyOpen.set(true)
}
export function closeHistory(): void {
  historyOpen.set(false)
}

// -- Go to Line keyboard fallback --------------------------------------------

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
 * True when `e` is the CmdOrCtrl+L Go to Line keyboard fallback for the
 * given platform. On mac, ctrlKey is EXCLUDED even alongside metaKey --
 * CodeMirror binds mac Ctrl-L to selectLine, so treating it as Go to Line
 * in split mode would fight CM's own binding. Everywhere else CmdOrCtrl+L
 * IS Ctrl+L (there's no metaKey to fall back from), and CM's non-mac
 * selectLine binding is Alt-L, not Ctrl-L, so ctrlKey is safe to honor there
 * -- excluding it unconditionally would make the fallback unreachable by
 * keyboard on Windows/Linux.
 */
export function isGotoLineFallbackKey(
  e: { metaKey: boolean; ctrlKey: boolean; key: string },
  mac: boolean,
): boolean {
  if (e.key.toLowerCase() !== 'l') return false
  return mac ? e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey
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
 * keymap has no Alt-f binding to collide with.
 */
export function isFindReplaceFallbackKey(
  e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string },
): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyF'
}

/** Export request counter; the export feature subscribes and acts on ticks. */
export const exportTick: Writable<number> = writable(0)
export function requestExport(): void {
  exportTick.update((n) => n + 1)
}

/** Open workspace folder basename for the Header breadcrumb; set by workspace. */
export const workspaceName: Writable<string | null> = writable(null)

/** Header breadcrumb: muted segments before the filename, plus the filename itself. */
export interface FileBreadcrumb {
  crumbs: string[]
  filename: string
}

/**
 * True when `path` is `root` or nested under it, matched segment-by-segment
 * (not by string prefix, so a sibling folder like `/ws/project2` isn't
 * mistaken for a child of `/ws/proj`). A segment-less root ('/' or '') would
 * make the check vacuously true for every path, so it always returns false
 * instead — an empty/root root never counts as containing anything.
 */
export function isInsideRoot(path: string, root: string): boolean {
  const pathSegments = path.split('/').filter(Boolean)
  const rootSegments = root.split('/').filter(Boolean)
  return rootSegments.length > 0 && rootSegments.every((seg, i) => pathSegments[i] === seg)
}

/**
 * Header breadcrumb segments for the open document.
 *
 * - No path (untitled doc): no crumbs, filename "Untitled".
 * - Path inside the open workspace: crumbs are the workspace root name plus
 *   every intermediate folder between the root and the file (path relative to
 *   `workspaceRoot`), so nested files show their full in-workspace ancestry.
 * - Anything else — no workspace open, or a path outside the workspace root
 *   (see `isInsideRoot`) — falls back to just the immediate parent folder, so
 *   the header never leaks a long absolute path.
 */
export function fileBreadcrumb(
  path: string | null,
  workspaceRoot: string | null,
  workspaceName: string | null,
): FileBreadcrumb {
  if (path === null) return { crumbs: [], filename: 'Untitled' }

  const segments = path.split('/').filter(Boolean)
  const filename = segments[segments.length - 1] ?? path

  if (workspaceRoot !== null && workspaceName !== null && isInsideRoot(path, workspaceRoot)) {
    const rootSegments = workspaceRoot.split('/').filter(Boolean)
    const dirs = segments.slice(rootSegments.length, -1)
    return { crumbs: [workspaceName, ...dirs], filename }
  }

  const parent = segments[segments.length - 2]
  return { crumbs: parent ? [parent] : [], filename }
}

// -- pure status-bar helpers --------------------------------------------------

// Hoisted: formatInt runs per keystroke (words/chars) — don't allocate a
// formatter per call.
const intFormat = new Intl.NumberFormat('en-US')

/** Comma-grouped integer, e.g. 1842 -> "1,842". */
export function formatInt(n: number): string {
  return intFormat.format(n)
}

/** Status-bar Ln/Col text; null when there is no cursor (segment hidden). */
export function lnColText(c: CursorPos | null): string | null {
  return c === null ? null : `Ln ${c.line}, Col ${c.col}`
}

/** Status-bar watch label (honest replacement for the mock's "Engine Connected"). */
export function watchLabel(s: WatchStatus): 'Live' | 'Idle' {
  return s === 'watching' ? 'Live' : 'Idle'
}
