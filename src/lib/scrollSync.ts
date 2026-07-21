// Split-view scroll sync: one-way, proportional, source (CodeMirror) -> preview
// (read-only Crepe pane). The preview has NO scroll listener registered on it,
// so there is no reverse path and therefore no feedback loop to guard against
// -- that guarantee is structural, not a suppress-flag. rAF coalesces bursts
// of scroll events into at most one preview write per animation frame.
//
// v1 ships proportional mapping only (fraction of scroll range mirrored 1:1).
// Heading/block-anchor mapping was considered and deferred: Crepe's rendered
// ProseMirror doc carries no source-position map back to the CodeMirror doc,
// so an anchor mode would need to correlate Nth-heading-in-source (via CM's
// syntax tree) to Nth-heading-in-preview (via querySelectorAll on the
// rendered DOM) and interpolate between anchors, with fallbacks for count
// mismatches / heading-less docs. That can be layered on later as a drop-in
// replacement for `proportionalTarget` behind the same `createScrollSync`
// controller and refs, using CodeMirror's BlockInfo/lineBlockAt geometry
// APIs -- without touching the wiring below.

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Destination scrollTop that mirrors the source's scroll fraction.
 *
 * Either pane being non-scrollable (its content fits without overflow)
 * yields 0 -- there is no meaningful fraction to mirror. The result is
 * always clamped to [0, dstMax] so it can never overshoot the destination's
 * scroll range, even under transient/rounding conditions.
 */
export function proportionalTarget(src: ScrollMetrics, dst: ScrollMetrics): number {
  const srcMax = src.scrollHeight - src.clientHeight
  const dstMax = dst.scrollHeight - dst.clientHeight
  if (srcMax <= 0 || dstMax <= 0) return 0
  const fraction = src.scrollTop / srcMax
  return Math.max(0, Math.min(dstMax, fraction * dstMax))
}

/**
 * Wires one-way source -> preview scroll sync. Adds a passive `scroll`
 * listener on `sourceScrollEl`, rAF-throttled, that writes
 * `previewEl.scrollTop` to `proportionalTarget`'s result. Returns a dispose
 * function that cancels any pending frame and removes the listener.
 */
export function createScrollSync(sourceScrollEl: HTMLElement, previewEl: HTMLElement): () => void {
  let frame = 0
  const onScroll = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      previewEl.scrollTop = proportionalTarget(sourceScrollEl, previewEl)
    })
  }
  sourceScrollEl.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    if (frame) cancelAnimationFrame(frame)
    sourceScrollEl.removeEventListener('scroll', onScroll)
  }
}
