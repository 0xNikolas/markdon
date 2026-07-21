import { describe, it, expect } from 'vitest'
import { parseGoto, lineCount, clampLine } from './gotoLine'

describe('parseGoto', () => {
  it('parses a bare line number (col defaults to 0)', () => {
    expect(parseGoto('14')).toEqual({ line: 14, col: 0 })
  })

  it('parses line:col', () => {
    expect(parseGoto('14:42')).toEqual({ line: 14, col: 42 })
  })

  it('parses a trailing colon with no col as col 0', () => {
    expect(parseGoto('14:')).toEqual({ line: 14, col: 0 })
  })

  it('trims surrounding whitespace', () => {
    expect(parseGoto(' 3 ')).toEqual({ line: 3, col: 0 })
  })

  it('rejects empty input', () => {
    expect(parseGoto('')).toBeNull()
    expect(parseGoto('   ')).toBeNull()
  })

  it('rejects non-numeric input', () => {
    expect(parseGoto('abc')).toBeNull()
  })

  it('rejects a missing line before the colon', () => {
    expect(parseGoto(':5')).toBeNull()
  })

  it('rejects line 0 and negative lines', () => {
    expect(parseGoto('0')).toBeNull()
    expect(parseGoto('-3')).toBeNull()
  })

  it('rejects a negative col', () => {
    expect(parseGoto('1:-2')).toBeNull()
  })

  it('rejects a non-numeric col', () => {
    expect(parseGoto('1:x')).toBeNull()
  })
})

describe('lineCount', () => {
  it('counts a single line with no newline as 1', () => {
    expect(lineCount('a')).toBe(1)
  })

  it('counts each newline as a new line', () => {
    expect(lineCount('a\nb')).toBe(2)
  })

  it('counts a trailing newline as a trailing empty line', () => {
    expect(lineCount('a\n')).toBe(2)
  })

  it('counts an empty document as 1 line', () => {
    expect(lineCount('')).toBe(1)
  })
})

describe('clampLine', () => {
  it('leaves an in-range line untouched', () => {
    expect(clampLine(5, 10)).toBe(5)
  })

  it('clamps below the minimum (1) up to 1', () => {
    expect(clampLine(0, 10)).toBe(1)
    expect(clampLine(-3, 10)).toBe(1)
  })

  it('clamps above the total line count down to the last line', () => {
    expect(clampLine(99, 10)).toBe(10)
  })

  it('clamps to 1 when the document has a single line', () => {
    expect(clampLine(5, 1)).toBe(1)
  })
})
