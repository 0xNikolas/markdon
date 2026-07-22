// The ProseMirror wiring for in-document search. Imports ONLY from
// '@milkdown/kit/prose/*' and '@milkdown/kit/utils' -- never 'prosemirror-*'
// directly -- so `Plugin`/`Decoration`/etc. are the exact instances Milkdown
// itself uses, not a second, incompatible copy of the same classes.
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import { get, writable } from 'svelte/store'

import { findMatches, stepIndex, type Segment, type MatchRange, type MatchOptions } from './search'

interface SearchState {
  query: string
  matches: MatchRange[]
  activeIndex: number
  decorations: DecorationSet
  opts: MatchOptions
}

type SearchMeta =
  | { type: 'set'; query: string }
  | { type: 'clear' }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'setOptions'; opts: MatchOptions }

/** What FindBar renders. Kept separate from the plugin's internal
 * `SearchState` (which also holds the DecorationSet) so the UI store stays
 * cheap to subscribe to and serializable. `replaceOpen` is UI-only (which
 * row is visible); it never feeds into plugin state or compute(). */
export const searchUi = writable<{
  open: boolean
  query: string
  count: number
  activeIndex: number
  caseSensitive: boolean
  wholeWord: boolean
  replaceOpen: boolean
}>({ open: false, query: '', count: 0, activeIndex: -1, caseSensitive: false, wholeWord: false, replaceOpen: false })

const key = new PluginKey<SearchState>('markdon-search')

// Registered by the plugin's view() hook so command functions (called from
// FindBar, outside the ProseMirror tree) can dispatch transactions. A
// singleton is fine for this single-editor app; survives {#key loadId}
// remounts because the new view registers itself and re-seeds from
// searchUi's current query in state.init.
let activeView: EditorView | null = null

/** Walk the doc's text nodes into position-tagged segments. Leaf atoms
 * (images, hard breaks, etc.) simply produce no segment, which is exactly
 * the "gap" findMatches needs to keep a match from spanning them. */
export function collectSegments(doc: Node): Segment[] {
  const segments: Segment[] = []
  doc.descendants((node, pos) => {
    if (node.isText && node.text) segments.push({ text: node.text, pos })
    return true
  })
  return segments
}

function compute(doc: Node, query: string, wantIndex: number, opts: MatchOptions): SearchState {
  const matches = findMatches(collectSegments(doc), query, opts)
  const activeIndex = matches.length === 0 ? -1 : Math.min(Math.max(wantIndex, 0), matches.length - 1)
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === activeIndex ? 'find-match find-active' : 'find-match' }),
    ),
  )
  return { query, matches, activeIndex, decorations, opts }
}

/** Push the plugin's computed state into the UI store, preserving `open`
 * and `replaceOpen` (only openFind/closeFind/openReplace touch those). */
function syncUi(state: SearchState): void {
  searchUi.update((ui) => ({
    ...ui,
    query: state.query,
    count: state.matches.length,
    activeIndex: state.activeIndex,
    caseSensitive: state.opts.caseSensitive,
    wholeWord: state.opts.wholeWord,
  }))
}

function scrollActiveIntoView(): void {
  activeView?.dom.querySelector('.find-active')?.scrollIntoView({ block: 'center' })
}

/** Builds the raw ProseMirror plugin. Exported (in addition to being wrapped
 * by $prose below) so tests can construct it directly against a plain
 * EditorState, without needing to boot a full Milkdown/Crepe editor -- the
 * $prose wrapper only exposes its `.plugin()` after Milkdown's ctx machinery
 * has run the factory, which never happens outside a real editor instance. */
export function buildSearchPlugin(): Plugin<SearchState> {
  return new Plugin<SearchState>({
    key,
    state: {
      // Re-seeds from the last-known query/options so an open search
      // survives an editor remount (e.g. {#key loadId} on New/Open).
      init: (_, editorState) => {
        const ui = get(searchUi)
        return compute(editorState.doc, ui.query, 0, { caseSensitive: ui.caseSensitive, wholeWord: ui.wholeWord })
      },
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(key) as SearchMeta | undefined
        if (!meta) {
          if (!tr.docChanged) return value
          // No active search (find bar closed/empty): matches are already
          // empty and stay empty regardless of doc edits, so skip the
          // O(doc-size) collectSegments/findMatches walk entirely. This
          // keeps ordinary typing with search closed at zero extra cost.
          if (value.query === '') return value
          // Doc changed without a search meta: recompute against the same
          // query/options, keeping the active index steady where possible.
          return compute(newState.doc, value.query, value.activeIndex, value.opts)
        }
        if (meta.type === 'clear') return compute(newState.doc, '', 0, value.opts)
        if (meta.type === 'set') return compute(newState.doc, meta.query, 0, value.opts)
        if (meta.type === 'setOptions') return compute(newState.doc, value.query, 0, meta.opts)
        // 'step'
        const next = stepIndex(value.matches.length, value.activeIndex, meta.delta)
        return compute(newState.doc, value.query, next, value.opts)
      },
    },
    props: {
      decorations: (editorState) => key.getState(editorState)?.decorations ?? DecorationSet.empty,
    },
    view: (v) => {
      activeView = v
      const state = key.getState(v.state)
      if (state) syncUi(state)
      return {
        destroy: () => {
          if (activeView === v) activeView = null
        },
      }
    },
  })
}

export const searchPlugin = $prose(buildSearchPlugin)

function dispatch(meta: SearchMeta): void {
  if (!activeView) return
  activeView.dispatch(activeView.state.tr.setMeta(key, meta))
  const state = key.getState(activeView.state)
  if (state) syncUi(state)
}

/** Open the find bar. Does not touch the query/matches -- if a query was
 * already active (e.g. before a Cmd+F close/reopen) its highlights are still
 * live from plugin state, so reopening just reveals the bar again. Leaves
 * `replaceOpen` as-is (plain Cmd+F never expands the replace row). */
export function openFind(): void {
  searchUi.update((ui) => ({ ...ui, open: true }))
}

/** Open the find bar with the replace row expanded (menu:find_replace /
 * Cmd+Alt+F). Like openFind, does not touch the query/matches. */
export function openReplace(): void {
  searchUi.update((ui) => ({ ...ui, open: true, replaceOpen: true }))
}

/** Close the find bar, clear all highlights, and collapse the replace row. */
export function closeFind(): void {
  dispatch({ type: 'clear' })
  searchUi.update((ui) => ({ ...ui, open: false, query: '', count: 0, activeIndex: -1, replaceOpen: false }))
}

/**
 * True when a mode switch should force-close an already-open WYSIWYG find
 * bar. Split mode has no target for it: entering split unmounts the only
 * <Editor> the plugin's `activeView` could point at (its view.destroy()
 * hook nulls `activeView`), so a FindBar left open would render above
 * <SplitView> with every interaction silently no-oping (dispatch()
 * early-returns without an activeView). This covers any control that flips
 * `split` -- not just routeFind()'s Cmd+F handling, which only routes *new*
 * find invocations and does nothing for a bar that was already open.
 */
export function shouldForceCloseFind(enteringSplit: boolean, findOpen: boolean): boolean {
  return enteringSplit && findOpen
}

/**
 * True only on the false->true transition of `open` -- i.e. the bar just
 * opened (Cmd+F or Cmd+Alt+F), not "the bar happens to be open right now".
 * FindBar's focus effect must use this, not a bare `if ($searchUi.open)`:
 * Svelte's store subscription re-runs an effect that reads `$searchUi` on
 * EVERY searchUi.update() call, because the whole store object is the
 * reactive source, not the individual `open` field. setCaseSensitive,
 * setWholeWord, replaceOne, replaceAll and toggleReplaceRow all update
 * searchUi while the bar is already open (chip clicks, Replace/Replace All,
 * Enter in the replace field, the chevron), so an unconditional focus() on
 * every re-run would yank focus back to the Find input after each of those
 * -- breaking iterative replace-via-Enter and stealing focus from whatever
 * control the user just used.
 */
export function shouldFocusFind(wasOpen: boolean, isOpen: boolean): boolean {
  return isOpen && !wasOpen
}

export function setQuery(query: string): void {
  dispatch({ type: 'set', query })
}

export function findNext(): void {
  dispatch({ type: 'step', delta: 1 })
  scrollActiveIntoView()
}

export function findPrev(): void {
  dispatch({ type: 'step', delta: -1 })
  scrollActiveIntoView()
}

export function setCaseSensitive(caseSensitive: boolean): void {
  dispatch({ type: 'setOptions', opts: { caseSensitive, wholeWord: get(searchUi).wholeWord } })
}

export function setWholeWord(wholeWord: boolean): void {
  dispatch({ type: 'setOptions', opts: { caseSensitive: get(searchUi).caseSensitive, wholeWord } })
}

/**
 * Replace only the active match, then advance. Builds one ordinary
 * (addToHistory-default) transaction so @milkdown/plugin-listener's
 * markdownUpdated fires -> onChange -> edit() -> dirty tracking, exactly
 * like a normal edit; NEVER dispatch with addToHistory:false here (that
 * would silently suppress markdownUpdated). tr.insertText inherits marks
 * across the replaced range via $from.marksAcross, so replacing inside
 * bold/italic keeps the mark. After the doc-changing dispatch, apply()'s
 * no-meta branch recomputes matches against the same query and the SAME
 * numeric activeIndex now names what was the next match -- i.e. replace
 * advances for free (clamped at the end by compute()).
 */
export function replaceOne(replacement: string): void {
  if (!activeView) return
  const st = key.getState(activeView.state)
  if (!st || st.activeIndex < 0) return
  const m = st.matches[st.activeIndex]
  activeView.dispatch(activeView.state.tr.insertText(replacement, m.from, m.to))
  const next = key.getState(activeView.state)
  if (next) syncUi(next)
  scrollActiveIntoView()
}

/**
 * Replace every match in a SINGLE transaction -- one dispatch, one undo
 * step. Iterates matches BACK-TO-FRONT: each insertText only shifts
 * positions above it, so every lower, not-yet-applied range stays valid
 * against the growing transaction (matches from findMatches are within-run
 * non-overlapping and document-ordered, so a plain reverse walk is safe).
 * A front-to-back loop on one tr would invalidate every later stored
 * position -- do not reorder this.
 */
export function replaceAll(replacement: string): void {
  if (!activeView) return
  const st = key.getState(activeView.state)
  if (!st || st.matches.length === 0) return
  const tr = activeView.state.tr
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const m = st.matches[i]
    tr.insertText(replacement, m.from, m.to) // mutates & returns `this`; marks inherited via marksAcross
  }
  activeView.dispatch(tr)
  const next = key.getState(activeView.state)
  if (next) syncUi(next)
}
