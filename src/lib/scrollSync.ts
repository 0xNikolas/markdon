// Split-view scroll sync: one-way, proportional, source (CodeMirror) ->
// preview (read-only Crepe pane). rAF coalesces bursts of scroll events into
// at most one preview write per animation frame.
//
// One-way does not mean "never listens to the preview": the preview does get
// a `scroll` listener, but purely to detect when the *user* has scrolled it
// by hand (as opposed to us reflecting our own write) -- there is still no
// reverse path that ever writes to the source. When a manual preview scroll
// is detected, sync *yields*: further source-scroll events (including
// CodeMirror's routine auto-scroll-into-view during normal typing, which
// fires on the same `scroll` event and is indistinguishable from deliberate
// scrolling by the event alone) stop overwriting the preview's position,
// so the user's manual scroll sticks instead of being silently discarded.
// Sync resumes once the user deliberately re-engages the source pane's own
// scrolling (wheel or a pointer/touch gesture on it), signalling they want
// the preview to follow source again.
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

/** How close (px) a preview scrollTop must be to our last write to count as
 * an echo of that write rather than a manual scroll by the user. Written
 * values can come back slightly rounded (subpixel/zoom), so this is a
 * tolerance, not an exact-equality check. */
const WRITE_ECHO_TOLERANCE_PX = 1

export interface ScrollSyncState {
  /** True once a manual preview scroll has been detected; while yielded,
   * source-scroll events are not forwarded to the preview. */
  readonly yielded: boolean
  /** scrollTop of the last value we wrote to the preview, used to tell our
   * own write's resulting `scroll` event apart from a user-driven one. */
  readonly lastWrittenTop: number | null
}

export const initialScrollSyncState: ScrollSyncState = { yielded: false, lastWrittenTop: null }

/** Whether a source `scroll` event should currently be forwarded to the preview. */
export function shouldSync(state: ScrollSyncState): boolean {
  return !state.yielded
}

/** Records that we just wrote `top` to the preview's scrollTop ourselves. */
export function recordWrite(state: ScrollSyncState, top: number): ScrollSyncState {
  return { ...state, lastWrittenTop: top }
}

/**
 * Feed a `scroll` event observed on the preview pane. If its scrollTop
 * matches the value we last wrote (within tolerance), it's an echo of our
 * own sync write and is ignored. Otherwise the user scrolled the preview by
 * hand: sync yields until they re-engage the source pane's scrolling.
 */
export function onPreviewScrolled(state: ScrollSyncState, previewScrollTop: number): ScrollSyncState {
  const isEcho =
    state.lastWrittenTop !== null && Math.abs(previewScrollTop - state.lastWrittenTop) < WRITE_ECHO_TOLERANCE_PX
  if (isEcho) return state
  return { ...state, yielded: true }
}

/**
 * Feed a deliberate scroll-intent signal (wheel / pointerdown / touchstart)
 * observed on the source pane -- resumes sync if it had yielded.
 */
export function onSourceScrollIntent(state: ScrollSyncState): ScrollSyncState {
  if (!state.yielded) return state
  return { ...state, yielded: false }
}

/**
 * Wires one-way source -> preview scroll sync. Adds a passive `scroll`
 * listener on `sourceScrollEl`, rAF-throttled, that writes
 * `previewEl.scrollTop` to `proportionalTarget`'s result -- unless sync has
 * yielded to a manual preview scroll (see module doc). A passive `scroll`
 * listener on `previewEl` detects those manual scrolls, and passive
 * `wheel`/`pointerdown`/`touchstart` listeners on `sourceScrollEl` detect
 * the user's intent to resume. Returns a dispose function that cancels any
 * pending frame and removes all listeners.
 */
export function createScrollSync(sourceScrollEl: HTMLElement, previewEl: HTMLElement): () => void {
  let frame = 0
  let state = initialScrollSyncState

  const onSourceScroll = (): void => {
    if (!shouldSync(state)) return
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      // Re-check shouldSync here, not just at schedule time: a manual preview
      // scroll can flip yield state during the wait between scheduling this
      // frame and it actually running, and we must not clobber that scroll
      // with a stale write. Metrics are also re-read fresh (rather than
      // reusing whatever was captured at schedule time) so the target
      // reflects the panes' current position, not a stale one.
      if (!shouldSync(state)) return
      const target = proportionalTarget(sourceScrollEl, previewEl)
      state = recordWrite(state, target)
      previewEl.scrollTop = target
    })
  }

  const onPreviewScroll = (): void => {
    state = onPreviewScrolled(state, previewEl.scrollTop)
  }

  const onSourceIntent = (): void => {
    state = onSourceScrollIntent(state)
  }

  sourceScrollEl.addEventListener('scroll', onSourceScroll, { passive: true })
  previewEl.addEventListener('scroll', onPreviewScroll, { passive: true })
  sourceScrollEl.addEventListener('wheel', onSourceIntent, { passive: true })
  sourceScrollEl.addEventListener('pointerdown', onSourceIntent, { passive: true })
  sourceScrollEl.addEventListener('touchstart', onSourceIntent, { passive: true })

  return () => {
    if (frame) cancelAnimationFrame(frame)
    sourceScrollEl.removeEventListener('scroll', onSourceScroll)
    previewEl.removeEventListener('scroll', onPreviewScroll)
    sourceScrollEl.removeEventListener('wheel', onSourceIntent)
    sourceScrollEl.removeEventListener('pointerdown', onSourceIntent)
    sourceScrollEl.removeEventListener('touchstart', onSourceIntent)
  }
}
