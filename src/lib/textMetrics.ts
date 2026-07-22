// Word counting for the status bar, kept O(document) work OFF the keystroke
// path for large docs: small texts are counted synchronously, large ones are
// deferred to an idle callback with latest-wins coalescing.

// Count runs of letters/digits (keeping apostrophes/hyphens inside words) so
// markdown syntax tokens like `#`, `*`, `>` aren't counted as words.
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu

/**
 * Number of words in `text`. Exec-loops the shared regex instead of
 * `.match()` so no per-word match strings are materialized on multi-MB docs.
 */
export function countWords(text: string): number {
  WORD_RE.lastIndex = 0
  let count = 0
  while (WORD_RE.exec(text) !== null) count++
  return count
}

/**
 * Texts at or below this many chars are counted synchronously per update; a
 * Unicode-property regex over 64K chars is low-single-digit milliseconds.
 * Longer texts defer to idle time (the count is briefly stale, chars stay
 * exact in the status bar).
 */
export const SYNC_WORD_COUNT_LIMIT = 64_000

export interface IdleScheduler {
  schedule(cb: () => void): unknown
  cancel(handle: unknown): void
}

// typeof guards are mandatory twice over: vitest runs environment 'node',
// and WKWebView before Safari 18 lacks requestIdleCallback.
export const defaultIdleScheduler: IdleScheduler =
  typeof requestIdleCallback === 'function'
    ? {
        schedule: (cb) => requestIdleCallback(cb),
        cancel: (handle) => cancelIdleCallback(handle as number),
      }
    : {
        schedule: (cb) => setTimeout(cb, 150),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }

export interface WordCounter {
  update(text: string): void
  dispose(): void
}

/**
 * Size-adaptive word counter: `update()` reports the count synchronously via
 * `onCount` for texts at/below `syncLimit`, and otherwise schedules a single
 * idle callback that counts the latest text seen (earlier pending texts are
 * coalesced away, latest wins).
 */
export function createWordCounter(
  onCount: (n: number) => void,
  opts: { syncLimit?: number; scheduler?: IdleScheduler } = {},
): WordCounter {
  const syncLimit = opts.syncLimit ?? SYNC_WORD_COUNT_LIMIT
  const scheduler = opts.scheduler ?? defaultIdleScheduler
  let handle: unknown
  let pending: string | undefined

  function cancelPending(): void {
    if (handle !== undefined) {
      scheduler.cancel(handle)
      handle = undefined
    }
    pending = undefined
  }

  return {
    update(text: string): void {
      cancelPending()
      if (text.length <= syncLimit) {
        onCount(countWords(text))
        return
      }
      pending = text
      handle = scheduler.schedule(() => {
        handle = undefined
        const latest = pending
        pending = undefined
        if (latest !== undefined) onCount(countWords(latest))
      })
    },
    dispose(): void {
      cancelPending()
    },
  }
}
