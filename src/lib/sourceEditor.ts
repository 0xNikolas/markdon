// Everything CodeMirror 6 that isn't a Svelte component: the markdown
// highlight style, the reconfigurable compartments, the extension array, and
// a registered-view slot so App.svelte can route Cmd+F into the source pane's
// native search panel (mirrors searchPlugin.ts's activeView pattern).
//
// Imports ONLY from @codemirror/* and @lezer/highlight -- never prosemirror-*.
// All eight packages ship with @milkdown/crepe (single-instance, verified in
// bun.lock) and are promoted to direct dependencies in package.json.
import { Compartment, EditorState, type Extension } from '@codemirror/state'
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

/** Ln/Col of the primary selection head: line 1-based, col 0-based (matches
 * the design literals "Ln 1, Col 0" / "Ln 14, Col 42"). Pure over the state. */
export function cursorAt(state: EditorState): CursorPos {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, col: head - line.from }
}

/**
 * The full extension array for the source pane. Behavior opts (soft wrap, tab
 * width, auto-close brackets) come from the shared settings store; the four
 * compartments let SourcePane reconfigure them without a rebuild.
 */
export function sourceExtensions(
  s: Settings,
  readonly: boolean,
  onDocChange: (md: string) => void,
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
      if (u.docChanged) onDocChange(u.state.doc.toString())
      if (u.selectionSet || u.docChanged) onCursor(cursorAt(u.state))
    }),
  ]
}

// Registered-view slot (same pattern as searchPlugin.ts's activeView) so
// App.svelte can open the source pane's search panel for menu:find / Cmd+F
// without reaching into the component. A singleton is safe: only one source
// pane is ever mounted (split mode).
let sourceView: EditorView | null = null

export function registerSourceView(v: EditorView | null): void {
  sourceView = v
}

/** Open the CodeMirror search panel. Returns false (no-op) when no source
 * pane is mounted, so the WYSIWYG path can fall through to the FindBar. */
export function openSourceSearch(): boolean {
  if (!sourceView) return false
  return openSearchPanel(sourceView)
}
