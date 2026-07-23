import { describe, it, expect } from 'vitest'
import { stripKeyIntent } from './stripNav'

describe('stripKeyIntent', () => {
  it('returns null for an empty strip regardless of key', () => {
    expect(stripKeyIntent('ArrowDown', -1, 0)).toBeNull()
    expect(stripKeyIntent('Home', -1, 0)).toBeNull()
  })

  it('ArrowDown moves to the next row, clamped at the last (no wrap)', () => {
    expect(stripKeyIntent('ArrowDown', 0, 3)).toEqual({ kind: 'focus', index: 1 })
    expect(stripKeyIntent('ArrowDown', 2, 3)).toBeNull() // already last: clamped no-op
  })

  it('ArrowUp moves to the previous row, clamped at the first', () => {
    expect(stripKeyIntent('ArrowUp', 2, 3)).toEqual({ kind: 'focus', index: 1 })
    expect(stripKeyIntent('ArrowUp', 0, 3)).toBeNull()
  })

  it('with no focused row, ArrowDown lands first and ArrowUp lands last (treeNav parity)', () => {
    expect(stripKeyIntent('ArrowDown', -1, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(stripKeyIntent('ArrowUp', -1, 3)).toEqual({ kind: 'focus', index: 2 })
  })

  it('Home/End jump to the ends, no-oping when already there', () => {
    expect(stripKeyIntent('Home', 2, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(stripKeyIntent('Home', 0, 3)).toBeNull()
    expect(stripKeyIntent('End', 0, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(stripKeyIntent('End', 2, 3)).toBeNull()
  })

  it('ignores non-navigation keys (Enter/Space stay native button activation)', () => {
    expect(stripKeyIntent('Enter', 1, 3)).toBeNull()
    expect(stripKeyIntent(' ', 1, 3)).toBeNull()
    expect(stripKeyIntent('ArrowRight', 1, 3)).toBeNull()
    expect(stripKeyIntent('a', 1, 3)).toBeNull()
  })

  it('single-row strip: every arrow is a clamped no-op from that row', () => {
    expect(stripKeyIntent('ArrowDown', 0, 1)).toBeNull()
    expect(stripKeyIntent('ArrowUp', 0, 1)).toBeNull()
  })
})
