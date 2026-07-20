import { describe, it, expect } from 'vitest'

import { findMatches, stepIndex, type Segment } from './search'

describe('findMatches', () => {
  it('returns no matches for an empty query', () => {
    const segments: Segment[] = [{ text: 'hello world', pos: 1 }]
    expect(findMatches(segments, '')).toEqual([])
  })

  it('returns no matches when the query is longer than all the text', () => {
    const segments: Segment[] = [{ text: 'hi', pos: 1 }]
    expect(findMatches(segments, 'hello there')).toEqual([])
  })

  it('matches case-insensitively', () => {
    const segments: Segment[] = [{ text: 'the Foo bar', pos: 1 }]
    expect(findMatches(segments, 'foo')).toEqual([{ from: 5, to: 8 }])
  })

  it('finds multiple matches in document order', () => {
    const segments: Segment[] = [{ text: 'cat and cat and cat', pos: 1 }]
    expect(findMatches(segments, 'cat')).toEqual([
      { from: 1, to: 4 },
      { from: 9, to: 12 },
      { from: 17, to: 20 },
    ])
  })

  it('matches spanning two position-adjacent segments (mark boundary)', () => {
    // 'hello ' at pos 1 (chars 1..6), 'world' immediately follows at pos 7:
    // 1 + 'hello '.length === 7, so the segments are adjacent and coalesce
    // into one search run 'hello world'.
    const segments: Segment[] = [
      { text: 'hello ', pos: 1 },
      { text: 'world', pos: 7 },
    ]
    expect(findMatches(segments, 'lo wor')).toEqual([{ from: 4, to: 10 }])
  })

  it('does not match across a positional gap (e.g. a hard break)', () => {
    // Segment 2 starts at pos 10, not pos 1 + 'hello'.length (6) -- a gap
    // (hard_break / inline atom / block boundary) breaks the search run.
    const segments: Segment[] = [
      { text: 'hello', pos: 1 },
      { text: 'world', pos: 10 },
    ]
    expect(findMatches(segments, 'loworld')).toEqual([])
    expect(findMatches(segments, 'hello')).toEqual([{ from: 1, to: 6 }])
    expect(findMatches(segments, 'world')).toEqual([{ from: 10, to: 15 }])
  })

  it('advances non-overlapping', () => {
    const segments: Segment[] = [{ text: 'aaaa', pos: 1 }]
    expect(findMatches(segments, 'aa')).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ])
  })

  it('maps offsets back to absolute document positions, not string offsets', () => {
    const segments: Segment[] = [{ text: 'needle', pos: 100 }]
    expect(findMatches(segments, 'needle')).toEqual([{ from: 100, to: 106 }])
  })
})

describe('stepIndex', () => {
  it('wraps forward past the last match to the first', () => {
    expect(stepIndex(3, 2, 1)).toBe(0)
  })

  it('wraps backward past the first match to the last', () => {
    expect(stepIndex(3, 0, -1)).toBe(2)
  })

  it('steps forward within bounds', () => {
    expect(stepIndex(3, 0, 1)).toBe(1)
  })

  it('returns -1 when there are no matches', () => {
    expect(stepIndex(0, 0, 1)).toBe(-1)
    expect(stepIndex(0, -1, -1)).toBe(-1)
  })
})
