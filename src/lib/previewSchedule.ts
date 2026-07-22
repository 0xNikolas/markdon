// Preview re-parse scheduling for split mode. Every push to the preview is a
// full remark parse + whole-doc ProseMirror replace (Milkdown's replaceAll),
// so the debounce delay scales with document size, and pushes are parked
// entirely while the document is hidden (minimized/occluded window) -- one
// parse on becoming visible instead of one per settle.
//
// Block-level reuse (re-parsing only changed blocks) was assessed and
// rejected: ProseMirror's ViewDesc update already reuses DOM for top-level
// nodes that compare eq, so the DOM half of the win exists; the remaining
// cost is the remark parse, which per-block reuse could only avoid by
// re-implementing remark's blockization exactly (setext headings, lazy
// continuation, lists spanning blanks, HTML blocks, GFM tables) while also
// ignoring cross-block dependencies (link-reference/footnote definitions
// change other blocks' rendering). Adaptive debounce + hidden-parking is the
// right cost/benefit.

export const MIN_PREVIEW_DELAY = 150
export const MAX_PREVIEW_DELAY = 1000

/**
 * Debounce delay (ms) before re-parsing a `charCount`-char document: today's
 * 150ms up to 30K chars, then scaling linearly to a 1s cap at 200K chars.
 */
export function previewDelay(charCount: number): number {
  return Math.min(MAX_PREVIEW_DELAY, Math.max(MIN_PREVIEW_DELAY, Math.floor(charCount / 200)))
}

export interface PreviewScheduler {
  /** Report the latest markdown; schedules (or parks) an `apply`. */
  notify(md: string): void
  /** Synchronously apply any pending markdown, hidden or not. */
  flush(): void
  dispose(): void
}

export interface PreviewSchedulerOptions {
  apply: (md: string) => void
  /** Markdown already rendered at construction time (mount-time no-op). */
  initial: string
  delayFor?: (md: string) => number
  isHidden?: () => boolean
  /** Subscribe `cb` to fire on becoming visible; returns unsubscribe. */
  onVisible?: (cb: () => void) => () => void
}

const defaultIsHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

const defaultOnVisible = (cb: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => {}
  const listener = (): void => {
    if (document.visibilityState === 'visible') cb()
  }
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

export function createPreviewScheduler(opts: PreviewSchedulerOptions): PreviewScheduler {
  const delayFor = opts.delayFor ?? ((md: string) => previewDelay(md.length))
  const isHidden = opts.isHidden ?? defaultIsHidden
  const onVisible = opts.onVisible ?? defaultOnVisible

  let lastApplied = opts.initial
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function applyPending(): void {
    if (pending === undefined) return
    const md = pending
    pending = undefined
    lastApplied = md
    opts.apply(md)
  }

  const unsubscribe = onVisible(() => {
    clearTimer()
    applyPending()
  })

  return {
    notify(md: string): void {
      clearTimer()
      if (md === lastApplied) {
        pending = undefined
        return
      }
      pending = md
      // While hidden, park with no timer: the visibility subscription (or an
      // explicit flush, e.g. export) applies the latest pending markdown.
      if (isHidden()) return
      timer = setTimeout(() => {
        timer = undefined
        // The window may have hidden while the timer was armed: re-park
        // (pending stays set) and let the visibility subscription apply it.
        if (isHidden()) return
        applyPending()
      }, delayFor(md))
    },
    flush(): void {
      clearTimer()
      applyPending()
    },
    dispose(): void {
      clearTimer()
      pending = undefined
      unsubscribe()
    },
  }
}
