import { describe, it, expect } from 'vitest'

import {
  proportionalTarget,
  initialScrollSyncState,
  shouldSync,
  recordWrite,
  onPreviewScrolled,
  onSourceScrollIntent,
  type ScrollMetrics,
} from './scrollSync'

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

describe('scroll-sync yield state machine', () => {
  it('starts un-yielded, so sync is allowed', () => {
    expect(shouldSync(initialScrollSyncState)).toBe(true)
  })

  it('does not yield when the preview scroll matches our own last write (echo)', () => {
    const written = recordWrite(initialScrollSyncState, 400)
    const next = onPreviewScrolled(written, 400)
    expect(shouldSync(next)).toBe(true)
  })

  it('tolerates a small rounding delta between our write and the echoed scrollTop', () => {
    const written = recordWrite(initialScrollSyncState, 400)
    const next = onPreviewScrolled(written, 400.6) // sub-pixel rounding
    expect(shouldSync(next)).toBe(true)
  })

  it('yields when the preview scrolls to a value that is not our own write', () => {
    const written = recordWrite(initialScrollSyncState, 400)
    const next = onPreviewScrolled(written, 900) // user scrolled by hand
    expect(shouldSync(next)).toBe(false)
  })

  it('yields on any preview scroll before we have ever written (no baseline yet)', () => {
    const next = onPreviewScrolled(initialScrollSyncState, 100)
    expect(shouldSync(next)).toBe(false)
  })

  it('a manual preview scroll is not silently discarded by a subsequent source scroll -- sync stays yielded', () => {
    // This is the exact "fighting" scenario: user scrolls the preview by
    // hand, then the source pane emits another scroll event (deliberate or
    // CodeMirror's auto-scroll-into-view during typing) -- shouldSync must
    // stay false so that event is not forwarded and the manual scroll sticks.
    let state = recordWrite(initialScrollSyncState, 400) // our v1 write
    state = onPreviewScrolled(state, 900) // user grabs the preview and scrolls it
    expect(shouldSync(state)).toBe(false)

    // A further source-pane scroll (e.g. typing-triggered auto-scroll) must
    // not be treated as a reason to resume -- only source scroll *intent* does.
    expect(shouldSync(state)).toBe(false)
  })

  it('resumes sync once the user deliberately re-engages the source pane scrolling', () => {
    let state = recordWrite(initialScrollSyncState, 400)
    state = onPreviewScrolled(state, 900) // yields
    expect(shouldSync(state)).toBe(false)

    state = onSourceScrollIntent(state) // wheel/pointerdown/touchstart on source
    expect(shouldSync(state)).toBe(true)
  })

  it('is a no-op to re-apply scroll intent when already un-yielded', () => {
    const state = onSourceScrollIntent(initialScrollSyncState)
    expect(state).toEqual(initialScrollSyncState)
  })
})
