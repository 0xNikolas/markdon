import { describe, it, expect } from 'vitest'

import { findMatches, stepIndex, type Segment, type MatchOptions } from './search'

const OFF: MatchOptions = { caseSensitive: false, wholeWord: false }

describe('findMatches', () => {
  it('returns no matches for an empty query', () => {
    const segments: Segment[] = [{ text: 'hello world', pos: 1 }]
    expect(findMatches(segments, '', OFF)).toEqual([])
  })

  it('returns no matches when the query is longer than all the text', () => {
    const segments: Segment[] = [{ text: 'hi', pos: 1 }]
    expect(findMatches(segments, 'hello there', OFF)).toEqual([])
  })

  it('matches case-insensitively by default', () => {
    const segments: Segment[] = [{ text: 'the Foo bar', pos: 1 }]
    expect(findMatches(segments, 'foo', OFF)).toEqual([{ from: 5, to: 8 }])
  })

  it('finds multiple matches in document order', () => {
    const segments: Segment[] = [{ text: 'cat and cat and cat', pos: 1 }]
    expect(findMatches(segments, 'cat', OFF)).toEqual([
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
    expect(findMatches(segments, 'lo wor', OFF)).toEqual([{ from: 4, to: 10 }])
  })

  it('does not match across a positional gap (e.g. a hard break)', () => {
    // Segment 2 starts at pos 10, not pos 1 + 'hello'.length (6) -- a gap
    // (hard_break / inline atom / block boundary) breaks the search run.
    const segments: Segment[] = [
      { text: 'hello', pos: 1 },
      { text: 'world', pos: 10 },
    ]
    expect(findMatches(segments, 'loworld', OFF)).toEqual([])
    expect(findMatches(segments, 'hello', OFF)).toEqual([{ from: 1, to: 6 }])
    expect(findMatches(segments, 'world', OFF)).toEqual([{ from: 10, to: 15 }])
  })

  it('advances non-overlapping', () => {
    const segments: Segment[] = [{ text: 'aaaa', pos: 1 }]
    expect(findMatches(segments, 'aa', OFF)).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ])
  })

  it('maps offsets back to absolute document positions, not string offsets', () => {
    const segments: Segment[] = [{ text: 'needle', pos: 100 }]
    expect(findMatches(segments, 'needle', OFF)).toEqual([{ from: 100, to: 106 }])
  })

  describe('caseSensitive option', () => {
    it('off (default): matches regardless of case', () => {
      const segments: Segment[] = [{ text: 'Foo foo FOO', pos: 1 }]
      expect(findMatches(segments, 'foo', { caseSensitive: false, wholeWord: false })).toEqual([
        { from: 1, to: 4 },
        { from: 5, to: 8 },
        { from: 9, to: 12 },
      ])
    })

    it('on: only matches the exact case', () => {
      const segments: Segment[] = [{ text: 'Foo foo FOO', pos: 1 }]
      expect(findMatches(segments, 'foo', { caseSensitive: true, wholeWord: false })).toEqual([
        { from: 5, to: 8 },
      ])
    })

    it('on: query case must match too', () => {
      const segments: Segment[] = [{ text: 'Foo foo FOO', pos: 1 }]
      expect(findMatches(segments, 'FOO', { caseSensitive: true, wholeWord: false })).toEqual([
        { from: 9, to: 12 },
      ])
    })
  })

  describe('wholeWord option', () => {
    it('excludes matches inside a longer word (ASCII)', () => {
      const segments: Segment[] = [{ text: 'a cat. scatter cats cat', pos: 1 }]
      // "a cat. scatter cats cat" (segment starts at pos 1)
      // 'cat' occurs at doc pos 3 ("cat."), 9 ("scatter" -- interior,
      // excluded), 16 ("cats" -- trailing 's', excluded), 21 ("cat" at the
      // end, whole word).
      expect(findMatches(segments, 'cat', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 3, to: 6 },
        { from: 21, to: 24 },
      ])
    })

    it('off: matches inside longer words too', () => {
      const segments: Segment[] = [{ text: 'scatter', pos: 1 }]
      expect(findMatches(segments, 'cat', { caseSensitive: false, wholeWord: false })).toEqual([
        { from: 2, to: 5 },
      ])
    })

    it('treats accented letters as word characters (café)', () => {
      const segments: Segment[] = [{ text: 'café bar', pos: 1 }]
      expect(findMatches(segments, 'café', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 1, to: 5 },
      ])
      // "caf" alone is not a whole word inside "café" -- the trailing é is a
      // word char, so there's no boundary between "caf" and "é".
      expect(findMatches(segments, 'caf', { caseSensitive: false, wholeWord: true })).toEqual([])
    })

    it('treats an apostrophe as a non-word boundary (don’t)', () => {
      const segments: Segment[] = [{ text: "don't stop", pos: 1 }]
      expect(findMatches(segments, 'don', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 1, to: 4 },
      ])
      expect(findMatches(segments, 't', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 5, to: 6 },
      ])
    })

    it('treats underscore as a word character (foo_bar stays one word)', () => {
      const segments: Segment[] = [{ text: 'foo_bar baz', pos: 1 }]
      expect(findMatches(segments, 'foo', { caseSensitive: false, wholeWord: true })).toEqual([])
      expect(findMatches(segments, 'foo_bar', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 1, to: 8 },
      ])
    })

    it('treats digits as word characters (blocks a12 from matching 12)', () => {
      const segments: Segment[] = [{ text: 'a12 12 x', pos: 1 }]
      expect(findMatches(segments, '12', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 5, to: 7 },
      ])
    })

    it('has no interior boundary in an adjacent CJK run (every char is a word char)', () => {
      const segments: Segment[] = [{ text: '你好世界', pos: 1 }]
      // Every character is \p{Alphabetic}, so a 2-char query in the middle of
      // the run has no boundary on either side and is excluded.
      expect(findMatches(segments, '好世', { caseSensitive: false, wholeWord: true })).toEqual([])
      // The full string IS a whole word (string edges count as boundaries).
      expect(findMatches(segments, '你好世界', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 1, to: 5 },
      ])
    })

    it('combines with caseSensitive', () => {
      const segments: Segment[] = [{ text: 'Cat cat scatter', pos: 1 }]
      expect(findMatches(segments, 'cat', { caseSensitive: true, wholeWord: true })).toEqual([
        { from: 5, to: 8 },
      ])
    })

    it('handles a query that starts and ends with punctuation', () => {
      const segments: Segment[] = [{ text: 'say "hi" now', pos: 1 }]
      expect(findMatches(segments, '"hi"', { caseSensitive: false, wholeWord: true })).toEqual([
        { from: 5, to: 9 },
      ])
    })
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
