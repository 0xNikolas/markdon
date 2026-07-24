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

/**
 * Split-preview mode, persisted across launches. Consumed by split-preview.
 * Deliberately NOT moved into the shared settings.json (unlike settings.ts):
 * it's read once per window at module load and in-memory after, so the
 * shared-localStorage last-writer-wins only affects the NEXT window's
 * default — and syncing it through settings would wrongly couple the split
 * state of every window.
 */
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

// Settings / Go to Line / File History visibility moved to overlay.ts, which
// unifies them (plus the discard guard) into one mutually-exclusive
// activeOverlay store — see openOverlay/closeOverlay there.

// The keyboard-matcher predicates (isMacPlatform, isGotoLineFallbackKey,
// isFindReplaceFallbackKey, isQuickOpenKey, fileCycleDirection,
// isReopenClosedKey) moved to keys.ts, next to their keymap.ts consumer.

/** Export request counter; the export feature subscribes and acts on ticks. */
export const exportTick: Writable<number> = writable(0)
export function requestExport(): void {
  exportTick.update((n) => n + 1)
}

/** Open workspace folder basename for the Header breadcrumb; set by workspace. */
export const workspaceName: Writable<string | null> = writable(null)

/**
 * True while the window shows the no-document empty page (EmptyState.svelte)
 * instead of an editor — VS Code's no-editor state. Raised by
 * doc.showEmptyState(), reached from exactly two flows: a boot with no
 * workspace at all (appBoot's maybeRestoreBootDocument — a workspace boot
 * instead restores its last-open file or a scratch) and closing the last
 * open file (App's onCloseFile). Cleared at the doc-load chokepoint — every
 * openDoc/restoreDoc/newDoc — so ANY route to a document (menu, sidebar,
 * startup drain, Cmd+N) dismisses the page without per-call-site wiring.
 * An explicit File > New never shows it: Cmd+N is newDoc(), the editable
 * scratch.
 */
export const emptyState: Writable<boolean> = writable(false)

/**
 * The image currently VIEWED in the editor area (its absolute path), or null
 * when a document is shown instead. A distinct non-editable view mode: it
 * overlays the editor while leaving $doc — and any unsaved buffer — untouched,
 * so returning to the document restores it with no reload. Set only by App's
 * showImage (a WorkspaceTree image-row click); cleared at the doc-load
 * chokepoint (every openDoc/restoreDoc/newDoc), so opening ANY document
 * dismisses the view without per-call-site wiring. Mutually exclusive with
 * emptyState — the image view wins over both $doc and $emptyState wherever
 * the two are read together (Header, window title, the editor-area branch).
 */
export const imageView: Writable<string | null> = writable(null)

// The pure path/title helpers (FileBreadcrumb, isInsideRoot, fileBreadcrumb,
// windowTitle) moved to paths.ts, the leaf path module.

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
