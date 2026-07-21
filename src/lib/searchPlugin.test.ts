// Regression test for the perf fix: apply() must not pay the O(doc-size)
// collectSegments/findMatches walk on every doc-changing transaction when
// there is no active search (query === ''). Exercises the raw ProseMirror
// Plugin (buildSearchPlugin) against a minimal schema -- no Milkdown/Crepe
// editor instantiation required.
import { describe, it, expect, afterEach } from 'vitest'
import { get } from 'svelte/store'
import { EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Schema } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

import {
  buildSearchPlugin,
  searchUi,
  shouldForceCloseFind,
  replaceOne,
  replaceAll,
  setCaseSensitive,
  setWholeWord,
} from './searchPlugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
})

afterEach(() => {
  // buildSearchPlugin's `init` seeds from searchUi's current query/options,
  // so reset it between tests to avoid cross-test leakage through the shared
  // store.
  searchUi.set({
    open: false,
    query: '',
    count: 0,
    activeIndex: -1,
    caseSensitive: false,
    wholeWord: false,
    replaceOpen: false,
  })
})

// replaceOne/replaceAll/setCaseSensitive/setWholeWord dispatch through the
// module-level `activeView` singleton, which the real app registers via the
// plugin's `view()` hook when Milkdown mounts a full EditorView -- that
// requires a DOM this project's vitest config deliberately doesn't provide
// (environment: 'node'; see scrollSync.test.ts's "no DOM/jsdom involved"
// precedent). Plugin.spec.view is the exact same callback the constructor
// would invoke, so calling it directly with a plain fake object registers
// `activeView` identically, without booting a real view. `dispatched` records
// every transaction the commands under test hand to `dispatch`, so tests can
// assert dispatch COUNT (one transaction = one undo step) alongside the
// resulting doc.
function fakeView(state: EditorState): { view: EditorView; dispatched: Transaction[] } {
  const dispatched: Transaction[] = []
  const view = {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      dispatched.push(tr)
      state = state.apply(tr)
    },
    dom: { querySelector: () => null },
  }
  return { view: view as unknown as EditorView, dispatched }
}

/** Mount `plugin` against a fresh state seeded from the current searchUi
 * store (mirrors what a real editor mount does), registering the fake view
 * as `activeView` via the plugin's own view() callback. */
function mount(plugin: ReturnType<typeof buildSearchPlugin>) {
  const state = EditorState.create({ schema, plugins: [plugin] })
  const { view, dispatched } = fakeView(state)
  plugin.spec.view?.(view)
  return { view, dispatched }
}

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
    searchUi.set({
      open: true,
      query: 'hel',
      count: 0,
      activeIndex: -1,
      caseSensitive: false,
      wholeWord: false,
      replaceOpen: false,
    })
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

describe('shouldForceCloseFind', () => {
  // Regression for the split-toggle FindBar leak: the header's Split Preview
  // button calls toggleSplit() directly, bypassing routeFind()'s mode-aware
  // Cmd+F routing entirely. If the WYSIWYG FindBar was already open, entering
  // split unmounts the only <Editor> the plugin's activeView could point at
  // (its view.destroy() hook nulls activeView), so the stale FindBar keeps
  // rendering above <SplitView> and every interaction becomes a silent no-op
  // (dispatch() early-returns without activeView). App.svelte's effect calls
  // closeFind() exactly when this predicate is true, for any control that
  // flips `split`, not just the header button.
  it('closes only when entering split while the find bar is open', () => {
    expect(shouldForceCloseFind(true, true)).toBe(true)
    expect(shouldForceCloseFind(true, false)).toBe(false)
    expect(shouldForceCloseFind(false, true)).toBe(false)
    expect(shouldForceCloseFind(false, false)).toBe(false)
  })
})

function seedSearchUi(overrides: Partial<Parameters<typeof searchUi.set>[0]> = {}) {
  searchUi.set({
    open: true,
    query: '',
    count: 0,
    activeIndex: -1,
    caseSensitive: false,
    wholeWord: false,
    replaceOpen: false,
    ...overrides,
  })
}

describe('replaceAll', () => {
  it('replaces every match in a single transaction (one undo step)', () => {
    seedSearchUi({ query: 'cat' })
    const plugin = buildSearchPlugin()
    const { view, dispatched } = mount(plugin)
    view.dispatch(view.state.tr.insertText('cat cat cat', 1))
    expect(plugin.getState(view.state)?.matches.length).toBe(3)

    dispatched.length = 0 // only count what replaceAll itself dispatches
    replaceAll('X')

    expect(dispatched.length).toBe(1) // one dispatch = one undo step
    expect(dispatched[0].docChanged).toBe(true)
    expect(view.state.doc.textBetween(0, view.state.doc.content.size)).toBe('X X X')
    // Every occurrence is gone, so a recompute against the same query finds none.
    expect(plugin.getState(view.state)?.matches.length).toBe(0)
  })

  it('is a no-op when there are no matches', () => {
    seedSearchUi({ query: 'nope' })
    const plugin = buildSearchPlugin()
    const { view, dispatched } = mount(plugin)
    view.dispatch(view.state.tr.insertText('cat cat cat', 1))

    dispatched.length = 0
    replaceAll('X')

    expect(dispatched.length).toBe(0)
  })
})

describe('replaceOne', () => {
  it('replaces only the active match and the same index advances to the next', () => {
    seedSearchUi({ query: 'cat' })
    const plugin = buildSearchPlugin()
    const { view, dispatched } = mount(plugin)
    view.dispatch(view.state.tr.insertText('cat cat cat', 1))

    const before = plugin.getState(view.state)!
    expect(before.matches.length).toBe(3)
    expect(before.activeIndex).toBe(0)

    dispatched.length = 0
    replaceOne('X')

    expect(dispatched.length).toBe(1) // one dispatch = one undo step for this replacement
    expect(dispatched[0].docChanged).toBe(true)
    expect(view.state.doc.textBetween(0, view.state.doc.content.size)).toBe('X cat cat')

    const after = plugin.getState(view.state)!
    // The replaced match left the set (3 -> 2); the SAME numeric activeIndex
    // (0) now names what was the next match -- replace advances for free.
    expect(after.matches.length).toBe(2)
    expect(after.activeIndex).toBe(0)
  })

  it('is a no-op when there is no active match', () => {
    seedSearchUi({ query: 'nope' })
    const plugin = buildSearchPlugin()
    const { view, dispatched } = mount(plugin)
    view.dispatch(view.state.tr.insertText('cat cat cat', 1))
    expect(plugin.getState(view.state)?.activeIndex).toBe(-1)

    dispatched.length = 0
    replaceOne('X')

    expect(dispatched.length).toBe(0)
  })
})

describe('setCaseSensitive / setWholeWord', () => {
  it('recompute honors the toggled options', () => {
    seedSearchUi({ query: 'Cat' })
    const plugin = buildSearchPlugin()
    const { view } = mount(plugin)
    view.dispatch(view.state.tr.insertText('Cat cats scatter', 1))

    // Default: case-insensitive, not whole-word -- matches inside all three words.
    expect(plugin.getState(view.state)?.matches.length).toBe(3)

    setCaseSensitive(true)
    // Only the exact-case leading "Cat" survives ("cats"/"scatter" are lowercase c).
    expect(plugin.getState(view.state)?.matches.length).toBe(1)

    setWholeWord(true)
    // Case-sensitive AND whole-word: still just the leading "Cat".
    expect(plugin.getState(view.state)?.matches.length).toBe(1)

    setCaseSensitive(false)
    // Whole-word only: "cats" (trailing s) and "scatter" (interior) are
    // excluded, leaving only the leading word.
    expect(plugin.getState(view.state)?.matches.length).toBe(1)

    setWholeWord(false)
    // Back to the default: all three substrings match again.
    expect(plugin.getState(view.state)?.matches.length).toBe(3)
  })

  it('round-trips into the searchUi store', () => {
    seedSearchUi({ query: 'x' })
    const plugin = buildSearchPlugin()
    mount(plugin)

    setCaseSensitive(true)
    expect(get(searchUi).caseSensitive).toBe(true)
    expect(get(searchUi).wholeWord).toBe(false)

    setWholeWord(true)
    expect(get(searchUi).caseSensitive).toBe(true)
    expect(get(searchUi).wholeWord).toBe(true)
  })
})
