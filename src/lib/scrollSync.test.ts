import { describe, it, expect } from 'vitest'

import { proportionalTarget, type ScrollMetrics } from './scrollSync'

function metrics(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight }
}

describe('proportionalTarget', () => {
  it('maps a 0.5 fraction to half of the destination range', () => {
    const src = metrics(500, 1500, 500) // range 1000, scrollTop 500 -> fraction 0.5
    const dst = metrics(0, 1200, 400) // range 800
    expect(proportionalTarget(src, dst)).toBe(400)
  })

  it('maps source top (0) to destination top (0)', () => {
    const src = metrics(0, 2000, 500)
    const dst = metrics(999, 1200, 400)
    expect(proportionalTarget(src, dst)).toBe(0)
  })

  it('maps source bottom (srcMax) to destination bottom (dstMax)', () => {
    const src = metrics(1500, 2000, 500) // range 1500, scrollTop == srcMax
    const dst = metrics(0, 1200, 400) // range 800
    expect(proportionalTarget(src, dst)).toBe(800)
  })

  it('returns 0 when the source pane is not scrollable (content fits)', () => {
    const src = metrics(0, 400, 400) // scrollHeight === clientHeight -> no range
    const dst = metrics(0, 1200, 400)
    expect(proportionalTarget(src, dst)).toBe(0)
  })

  it('returns 0 when the destination pane is not scrollable (content fits)', () => {
    const src = metrics(500, 1500, 500)
    const dst = metrics(0, 400, 400) // scrollHeight === clientHeight -> no range
    expect(proportionalTarget(src, dst)).toBe(0)
  })

  it('clamps the result so it never exceeds dstMax', () => {
    // Contrived metrics where scrollTop slightly exceeds srcMax (can happen
    // transiently in real browsers, e.g. elastic overscroll) -- the fraction
    // would be >1, so the target must still clamp to dstMax, not overshoot.
    const src = metrics(1100, 2000, 1000) // range 1000, scrollTop 1100 -> fraction 1.1
    const dst = metrics(0, 1000, 500) // range 500
    expect(proportionalTarget(src, dst)).toBe(500)
  })

  it('maps by fraction, not pixels, across differently sized panes', () => {
    const src = metrics(500, 1200, 200) // range 1000
    const dst = metrics(0, 400, 200) // range 200
    // fraction 0.5 -> 100, not 500 (which would overshoot dstMax anyway)
    expect(proportionalTarget(src, dst)).toBe(100)
  })
})
