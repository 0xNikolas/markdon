import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  cursorAt,
  tabExt,
  readonlyExt,
  gotoPos,
  maxLineLength,
  LONG_LINE_LIMIT,
} from './sourceEditor'

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

describe('maxLineLength', () => {
  it('is 0 for the empty string', () => {
    expect(maxLineLength('')).toBe(0)
  })

  it('is the full length when there is no newline', () => {
    expect(maxLineLength('abcde')).toBe(5)
  })

  it('ignores the empty final line after a trailing newline', () => {
    expect(maxLineLength('abc\n')).toBe(3)
  })

  it('finds the longest of several lines, including the last', () => {
    expect(maxLineLength('ab\ncdef\ng')).toBe(4)
    expect(maxLineLength('ab\ncd\nefghij')).toBe(6) // longest line is the unterminated tail
  })

  it('counts the \\r of a CRLF ending toward the line length', () => {
    // One char of inflation per line -- documented as fine at a 100K threshold.
    expect(maxLineLength('abc\r\nde')).toBe(4)
  })

  it('flags a synthetic data-URI-sized line while sparing real markdown', () => {
    const huge = '![](data:image/png;base64,' + 'A'.repeat(LONG_LINE_LIMIT) + ')'
    expect(maxLineLength(`# ok\n\n${huge}\n`)).toBeGreaterThan(LONG_LINE_LIMIT)
    expect(maxLineLength('# ok\n\nsome ordinary paragraph\n')).toBeLessThan(LONG_LINE_LIMIT)
  })
})

describe('gotoPos', () => {
  const doc = 'ab\ncde\nf' // offsets: a0 b1 \n2 | c3 d4 e5 \n6 | f7

  it('resolves line 1 col 0 to the start of the document', () => {
    expect(gotoPos(EditorState.create({ doc }), 1, 0)).toBe(0)
  })

  it('resolves a mid-line column on a later line', () => {
    // line 2 ("cde") starts at offset 3; col 2 -> offset 5
    expect(gotoPos(EditorState.create({ doc }), 2, 2)).toBe(5)
  })

  it('clamps a line above doc.lines to the last line', () => {
    // last line ("f") starts at offset 7
    expect(gotoPos(EditorState.create({ doc }), 99, 0)).toBe(7)
  })

  it('clamps a column past the line length to the end of the line', () => {
    // line 2 ("cde") has length 3, so col 99 clamps to its end (offset 6)
    expect(gotoPos(EditorState.create({ doc }), 2, 99)).toBe(6)
  })

  it('clamps a negative column to the start of the line', () => {
    expect(gotoPos(EditorState.create({ doc }), 2, -5)).toBe(3)
  })

  it('clamps a line below 1 up to line 1', () => {
    expect(gotoPos(EditorState.create({ doc }), 0, 0)).toBe(0)
  })
})
