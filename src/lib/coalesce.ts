// Trailing-edge debounce over a thunk. workspace.ts writes the Open Files strip
// through to disk on every store change; a burst (a multi-file drain pinning
// several rows, a bulk close) must collapse to ONE write instead of one per
// update. The thunk reads live state at fire time (recordTabState reads the
// stores), so this carries NO payload — which is exactly why previewSchedule.ts
// (a pending payload plus hidden-window parking) is a different primitive and
// is deliberately not folded in here.

export interface Coalesced {
  /** (Re)arm the trailing-edge timer; a burst of calls collapses to one fn(). */
  schedule(): void
  /** Run a pending fn() now and clear the timer; a no-op when idle. */
  flush(): void
  /** Drop a pending fn() WITHOUT running it. */
  cancel(): void
}

/**
 * Debounce `fn` on a trailing edge `ms` after the last `schedule()`. `flush()`
 * runs the pending fn immediately (window-close path); `cancel()` drops it
 * without running (test-reset / teardown that must NOT persist).
 */
export function coalesce(fn: () => void, ms: number): Coalesced {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(): void {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    flush(): void {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      fn()
    },
    cancel(): void {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    },
  }
}
