// The ProseMirror wiring for in-document search. Imports ONLY from
// '@milkdown/kit/prose/*' and '@milkdown/kit/utils' -- never 'prosemirror-*'
// directly -- so `Plugin`/`Decoration`/etc. are the exact instances Milkdown
// itself uses (see spec-search.json's verified re-export chain).
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import { get, writable } from 'svelte/store'

import { findMatches, stepIndex, type Segment, type MatchRange } from './search'

interface SearchState {
  query: string
  matches: MatchRange[]
  activeIndex: number
  decorations: DecorationSet
}

type SearchMeta =
  | { type: 'set'; query: string }
  | { type: 'clear' }
  | { type: 'step'; delta: 1 | -1 }

/** What FindBar renders. Kept separate from the plugin's internal
 * `SearchState` (which also holds the DecorationSet) so the UI store stays
 * cheap to subscribe to and serializable. */
export const searchUi = writable<{ open: boolean; query: string; count: number; activeIndex: number }>(
  { open: false, query: '', count: 0, activeIndex: -1 },
)

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

function compute(doc: Node, query: string, wantIndex: number): SearchState {
  const matches = findMatches(collectSegments(doc), query)
  const activeIndex = matches.length === 0 ? -1 : Math.min(Math.max(wantIndex, 0), matches.length - 1)
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === activeIndex ? 'find-match find-active' : 'find-match' }),
    ),
  )
  return { query, matches, activeIndex, decorations }
}

/** Push the plugin's computed state into the UI store, preserving `open`
 * (only openFind/closeFind change that). */
function syncUi(state: SearchState): void {
  searchUi.update((ui) => ({ ...ui, query: state.query, count: state.matches.length, activeIndex: state.activeIndex }))
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
      // Re-seeds from the last-known query so an open search survives an
      // editor remount (e.g. {#key loadId} on New/Open).
      init: (_, editorState) => compute(editorState.doc, get(searchUi).query, 0),
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
          // query, keeping the active index steady where possible.
          return compute(newState.doc, value.query, value.activeIndex)
        }
        if (meta.type === 'clear') return compute(newState.doc, '', 0)
        if (meta.type === 'set') return compute(newState.doc, meta.query, 0)
        // 'step'
        const next = stepIndex(value.matches.length, value.activeIndex, meta.delta)
        return compute(newState.doc, value.query, next)
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
 * live from plugin state, so reopening just reveals the bar again. */
export function openFind(): void {
  searchUi.update((ui) => ({ ...ui, open: true }))
}

/** Close the find bar and clear all highlights. */
export function closeFind(): void {
  dispatch({ type: 'clear' })
  searchUi.update((ui) => ({ ...ui, open: false, query: '', count: 0, activeIndex: -1 }))
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
