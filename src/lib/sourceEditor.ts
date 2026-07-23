// Everything CodeMirror 6 that isn't a Svelte component: the markdown
// highlight style, the reconfigurable compartments, the extension array, and
// a registered-view slot so App.svelte can route Cmd+F into the source pane's
// native search panel (mirrors searchPlugin.ts's activeView pattern).
//
// Imports ONLY from @codemirror/* and @lezer/highlight -- never prosemirror-*.
// All eight packages ship with @milkdown/crepe (single-instance, verified in
// bun.lock) and are promoted to direct dependencies in package.json.
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type Text,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import type { Settings } from './settings'
import type { CursorPos } from './ui'

// Figma node 11:195: every markdown marker (#, ##, -, >, **, `) is tagged
// tags.processingInstruction by @lezer/markdown, so ONE accent rule paints
// them all. Colors are `var(--...)` so light/dark follow the theme with no
// per-theme HighlightStyle. Typography (family/size/line-height) lives in
// cm-theme.css via the --editor-* settings vars -- headings/strong here only
// nudge relative weight/size, never absolute px, so the settings font-size
// control keeps working.
const mdHighlight = HighlightStyle.define([
  { tag: t.processingInstruction, color: 'var(--accent)' },
  { tag: t.heading1, fontSize: '1.4em', fontWeight: '600', color: 'var(--fg-strong)' },
  { tag: t.heading2, fontSize: '1.15em', fontWeight: '600', color: 'var(--fg-strong)' },
  { tag: t.heading3, fontWeight: '600', color: 'var(--fg-strong)' },
  { tag: t.strong, fontWeight: '600', color: 'var(--accent)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.monospace, color: 'var(--fg)' },
  { tag: t.labelName, color: 'var(--fg-muted)' },
  { tag: t.url, color: 'var(--fg-muted)' },
  { tag: t.link, color: 'var(--accent)' },
])

// Reconfigured live from the settings store (SourcePane's $effect) without
// rebuilding the whole editor state.
export const wrapC = new Compartment()
export const tabC = new Compartment()
export const bracketsC = new Compartment()
export const readonlyC = new Compartment()

/** Tab size + indent unit for the given width (spaces). Pure. */
export function tabExt(width: number): Extension {
  return [EditorState.tabSize.of(width), indentUnit.of(' '.repeat(width))]
}

/** Read-only + non-editable when `ro`, otherwise nothing. Pure. */
export function readonlyExt(ro: boolean): Extension {
  return ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
}

// WebKit hangs indefinitely (hard freeze, Force Quit territory) laying out a
// single multi-megabyte line the moment CodeMirror mounts one -- measured
// boundary: a 500K-char line renders fine, 1M+ freezes, and a bare CM with
// zero extensions already freezes, so no extension tweak can fix it. 100K
// leaves a wide margin below the freeze floor and no real markdown line comes
// close; the only realistic offender is an inlined data: URI image.
export const LONG_LINE_LIMIT = 100_000

/** Length of the longest line in `text`. Single indexOf('\n') scan -- no
 * split(), which would materialize a copy of a multi-MB document just to
 * measure it. A '\r' before the '\n' (CRLF) counts toward the length; that
 * one-char inflation is irrelevant at the 100K threshold. Pure. */
export function maxLineLength(text: string): number {
  let max = 0
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) return Math.max(max, text.length - start)
    if (nl - start > max) max = nl - start
    start = nl + 1
  }
}

/** Ln/Col of the primary selection head: line 1-based, col 0-based (matches
 * the design literals "Ln 1, Col 0" / "Ln 14, Col 42"). Pure over the state. */
export function cursorAt(state: EditorState): CursorPos {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, col: head - line.from }
}

// Docs at or below this length keep serializing synchronously on every
// docChanged update: a rope join under 64K is far below a frame budget, and a
// live doc.content keeps the split preview streaming while you type. Matches
// textMetrics' sync/deferred word-count threshold. Above it, materializing
// the whole string per keystroke is the last O(doc)-per-keystroke cost in the
// app, so big docs fall back to a trailing debounce at the same 200ms cadence
// as Crepe's hardwired @milkdown/plugin-listener — serialization then runs
// per PAUSE, and the pending window is bridged by bufferFlush.ts at every
// read point (save/export/guard/stash).
export const DOC_SYNC_LIMIT = 64_000
export const DOC_SYNC_DELAY_MS = 200

/**
 * The source pane's doc→store sync policy (see DOC_SYNC_LIMIT above).
 * `docChanged` is fed from the updateListener with the post-update rope;
 * `flush` lands a pending (debounced) serialization NOW — registered with
 * bufferFlush so save/export/guard reads are never stale; `cancel` drops any
 * pending emission without serializing (pane destroy: every doc-replacing
 * flow has already flushed through its own choke-point, so a late emission
 * here could only ever target the WRONG doc).
 */
export interface DocSync {
  docChanged(docText: Text): void
  flush(): void
  cancel(): void
}

export function createDocSync(
  onDocChange: (md: string) => void,
  delayMs: number = DOC_SYNC_DELAY_MS,
  syncLimit: number = DOC_SYNC_LIMIT,
): DocSync {
  let pending: Text | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }
  // Trailing-debounce fire; doubles as flush (no-op when nothing is pending).
  const fire = () => {
    const t = pending
    clear()
    if (t !== null) onDocChange(t.toString())
  }
  return {
    docChanged(docText: Text) {
      if (docText.length <= syncLimit) {
        // Small doc: serialize inline. Clears any timer a previously-large
        // doc armed (mass deletion shrank it) — this emission supersedes it.
        clear()
        onDocChange(docText.toString())
        return
      }
      pending = docText // latest rope wins; the string materializes on fire
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush: fire,
    cancel: clear,
  }
}

/**
 * The full extension array for the source pane. Behavior opts (soft wrap, tab
 * width, auto-close brackets) come from the shared settings store; the four
 * compartments let SourcePane reconfigure them without a rebuild. Doc changes
 * route through `docSync` (createDocSync) rather than a bare callback so
 * large docs don't pay an O(doc) toString per keystroke.
 */
export function sourceExtensions(
  s: Settings,
  readonly: boolean,
  docSync: Pick<DocSync, 'docChanged'>,
  onCursor: (c: CursorPos) => void,
): Extension[] {
  return [
    markdown({ base: markdownLanguage }), // GFM-flavored, parity with Crepe's gfm preset
    history(),
    search(), // native find panel; menu:find routes here in split mode
    bracketsC.of(s.autoCloseBrackets ? closeBrackets() : []),
    wrapC.of(s.softWrap ? EditorView.lineWrapping : []),
    tabC.of(tabExt(s.tabWidth)),
    readonlyC.of(readonlyExt(readonly)),
    syntaxHighlighting(mdHighlight),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...markdownKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) docSync.docChanged(u.state.doc)
      if (u.selectionSet || u.docChanged) onCursor(cursorAt(u.state))
    }),
  ]
}

// Registered-view slot (same pattern as searchPlugin.ts's activeView) so
// App.svelte can open the source pane's search panel for menu:find / Cmd+F
// without reaching into the component. A singleton is safe: only one source
// pane is ever mounted (split mode).
let sourceView: EditorView | null = null

// A Go to Line jump requested from WYSIWYG mode arrives BEFORE the source
// pane exists (entering split remounts SourcePane async) -- stash it here
// and flush it the moment registerSourceView sees the new view.
let pendingLine: { line: number; col: number } | null = null

/** Clamp a 1-based line + 0-based col to the doc and return the absolute
 * caret position. Pure over the state -- mirrors @codemirror/search's own
 * gotoLine clamp idiom (line clamped to [1, doc.lines], col clamped to
 * [0, line.length]). Exported for sourceEditor.test.ts's bare-EditorState
 * coverage. */
export function gotoPos(state: EditorState, line: number, col: number): number {
  const n = Math.max(1, Math.min(state.doc.lines, line))
  const l = state.doc.line(n)
  return l.from + Math.max(0, Math.min(col, l.length))
}

function applyGoToLine(view: EditorView, line: number, col: number): void {
  const pos = gotoPos(view.state, line, col)
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  })
  view.focus()
}

export function registerSourceView(v: EditorView | null): void {
  sourceView = v
  if (v && pendingLine) {
    const t = pendingLine
    pendingLine = null
    applyGoToLine(v, t.line, t.col)
  }
}

/** Open the CodeMirror search panel. Returns false (no-op) when no source
 * pane is mounted, so the WYSIWYG path can fall through to the FindBar. */
export function openSourceSearch(): boolean {
  if (!sourceView) return false
  return openSearchPanel(sourceView)
}

/**
 * Jump the source pane's caret to `line`/`col`, centered. Returns true if
 * the jump ran immediately (split mode already mounted); false if it was
 * queued to flush on the next registerSourceView (the caller just switched
 * into split mode and SourcePane hasn't mounted yet).
 */
export function goToSourceLine(line: number, col = 0): boolean {
  if (!sourceView) {
    pendingLine = { line, col }
    return false
  }
  applyGoToLine(sourceView, line, col)
  return true
}

/** Drop a queued-but-not-yet-flushed jump (e.g. the Go to Line popover was
 * closed, or split was toggled back off, before the source pane mounted) so
 * a later, unrelated source-pane mount can't fire a stale jump. */
export function clearPendingLine(): void {
  pendingLine = null
}
