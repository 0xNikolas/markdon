import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { cursorAt, tabExt, readonlyExt } from './sourceEditor'

/** Build a state with the caret at `head` so we can assert the Ln/Col mapping. */
function stateAt(doc: string, head: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: head } })
}

describe('cursorAt', () => {
  it('reports Ln 1, Col 0 at the start of the document', () => {
    expect(cursorAt(stateAt('hello', 0))).toEqual({ line: 1, col: 0 })
  })

  it('column is 0-based within a line', () => {
    // caret after "hel" on line 1
    expect(cursorAt(stateAt('hello', 3))).toEqual({ line: 1, col: 3 })
  })

  it('line is 1-based and column resets each line', () => {
    const doc = 'ab\ncde\nf'
    // offsets: a0 b1 \n2 | c3 d4 e5 \n6 | f7
    expect(cursorAt(stateAt(doc, 3))).toEqual({ line: 2, col: 0 }) // start of line 2
    expect(cursorAt(stateAt(doc, 5))).toEqual({ line: 2, col: 2 }) // after "cd"
    expect(cursorAt(stateAt(doc, 7))).toEqual({ line: 3, col: 0 }) // start of line 3
  })

  it('matches the design literal at the very end of a line', () => {
    // caret at end of "cde" (offset 6 is the newline; 6 belongs to line 2 col 3)
    expect(cursorAt(stateAt('ab\ncde', 6))).toEqual({ line: 2, col: 3 })
  })
})

describe('tabExt', () => {
  it('sets the tab size to the requested width', () => {
    const state = EditorState.create({ doc: '', extensions: tabExt(4) })
    expect(state.tabSize).toBe(4)
  })

  it('honors a width of 2', () => {
    const state = EditorState.create({ doc: '', extensions: tabExt(2) })
    expect(state.tabSize).toBe(2)
  })
})

describe('readonlyExt', () => {
  it('makes the state read-only when asked', () => {
    const state = EditorState.create({ doc: 'x', extensions: readonlyExt(true) })
    expect(state.readOnly).toBe(true)
  })

  it('leaves the state editable otherwise', () => {
    const state = EditorState.create({ doc: 'x', extensions: readonlyExt(false) })
    expect(state.readOnly).toBe(false)
  })
})
