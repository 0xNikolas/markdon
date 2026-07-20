// Regression test for the perf fix: apply() must not pay the O(doc-size)
// collectSegments/findMatches walk on every doc-changing transaction when
// there is no active search (query === ''). Exercises the raw ProseMirror
// Plugin (buildSearchPlugin) against a minimal schema -- no Milkdown/Crepe
// editor instantiation required.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@milkdown/kit/prose/state'
import { Schema } from '@milkdown/kit/prose/model'

import { buildSearchPlugin, searchUi } from './searchPlugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
})

afterEach(() => {
  // buildSearchPlugin's `init` seeds from searchUi's current query, so reset
  // it between tests to avoid cross-test leakage through the shared store.
  searchUi.set({ open: false, query: '', count: 0, activeIndex: -1 })
})

describe('searchPlugin apply', () => {
  it('short-circuits on doc-changing transactions when no search is active', () => {
    const plugin = buildSearchPlugin()
    let state = EditorState.create({ schema, plugins: [plugin] })
    const before = plugin.getState(state)
    expect(before?.query).toBe('')

    const tr = state.tr.insertText('hello', 1)
    expect(tr.docChanged).toBe(true)
    state = state.apply(tr)
    const after = plugin.getState(state)

    // Same object reference: apply() returned `value` unchanged instead of
    // calling compute() (which always allocates a fresh SearchState), proving
    // the full-doc walk was skipped for ordinary editing with search closed.
    expect(after).toBe(before)
  })

  it('still recomputes on doc-changing transactions while a search is active', () => {
    searchUi.set({ open: true, query: 'hel', count: 0, activeIndex: -1 })
    const plugin = buildSearchPlugin()
    let state = EditorState.create({ schema, plugins: [plugin] })
    const before = plugin.getState(state)
    expect(before?.query).toBe('hel')
    expect(before?.matches.length).toBe(0) // empty doc, no match yet

    const tr = state.tr.insertText('hello', 1)
    state = state.apply(tr)
    const after = plugin.getState(state)

    expect(after).not.toBe(before)
    expect(after?.matches.length).toBe(1)
  })
})
