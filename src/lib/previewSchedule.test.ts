import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPreviewScheduler,
  MAX_PREVIEW_DELAY,
  MIN_PREVIEW_DELAY,
  previewDelay,
  type PreviewSchedulerOptions,
} from './previewSchedule'

describe('previewDelay', () => {
  it('floors at the minimum for small documents', () => {
    expect(previewDelay(0)).toBe(MIN_PREVIEW_DELAY)
    expect(previewDelay(29_999)).toBe(MIN_PREVIEW_DELAY)
  })

  it('starts scaling at the 30K boundary', () => {
    expect(previewDelay(30_000)).toBe(150)
    expect(previewDelay(30_200)).toBe(151)
  })

  it('caps at the maximum for huge documents', () => {
    expect(previewDelay(200_000)).toBe(MAX_PREVIEW_DELAY)
    expect(previewDelay(5_000_000)).toBe(MAX_PREVIEW_DELAY)
  })

  it('is monotone non-decreasing between the clamps', () => {
    let prev = -1
    for (const n of [0, 10_000, 30_000, 60_000, 100_000, 150_000, 200_000, 300_000]) {
      const d = previewDelay(n)
      expect(d).toBeGreaterThanOrEqual(prev)
      expect(d).toBeGreaterThanOrEqual(MIN_PREVIEW_DELAY)
      expect(d).toBeLessThanOrEqual(MAX_PREVIEW_DELAY)
      prev = d
    }
  })
})

describe('createPreviewScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  interface Harness {
    apply: ReturnType<typeof vi.fn>
    hidden: boolean
    /** Simulates the document becoming visible again. */
    becomeVisible(): void
    visibleUnsubscribed: boolean
    scheduler: ReturnType<typeof createPreviewScheduler>
  }

  function make(overrides: Partial<PreviewSchedulerOptions> = {}): Harness {
    const apply = vi.fn()
    let visibleCb: (() => void) | undefined
    const h: Harness = {
      apply,
      hidden: false,
      becomeVisible() {
        h.hidden = false
        visibleCb?.()
      },
      visibleUnsubscribed: false,
      scheduler: undefined!,
    }
    h.scheduler = createPreviewScheduler({
      apply,
      initial: 'initial',
      isHidden: () => h.hidden,
      onVisible: (cb) => {
        visibleCb = cb
        return () => {
          h.visibleUnsubscribed = true
          visibleCb = undefined
        }
      },
      ...overrides,
    })
    return h
  }

  it('debounces a burst into one apply of the latest markdown', () => {
    const h = make()
    h.scheduler.notify('a')
    vi.advanceTimersByTime(50)
    h.scheduler.notify('ab')
    vi.advanceTimersByTime(50)
    h.scheduler.notify('abc')
    expect(h.apply).not.toHaveBeenCalled()

    vi.advanceTimersByTime(MIN_PREVIEW_DELAY)
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.apply).toHaveBeenCalledWith('abc')
  })

  it('uses delayFor(md) as the debounce delay', () => {
    const delayFor = vi.fn(() => 400)
    const h = make({ delayFor })
    h.scheduler.notify('x')
    expect(delayFor).toHaveBeenCalledWith('x')

    vi.advanceTimersByTime(399)
    expect(h.apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.apply).toHaveBeenCalledWith('x')
  })

  it('notify with the initial markdown applies nothing', () => {
    const h = make()
    h.scheduler.notify('initial')
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('notify(x) then notify(initial) cancels the pending apply', () => {
    const h = make()
    h.scheduler.notify('x')
    h.scheduler.notify('initial')
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()

    // and flush has nothing left to apply either
    h.scheduler.flush()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('does not re-apply markdown equal to the last applied value', () => {
    const h = make()
    h.scheduler.notify('x')
    vi.runAllTimers()
    expect(h.apply).toHaveBeenCalledTimes(1)

    h.scheduler.notify('x')
    vi.runAllTimers()
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('flush applies pending markdown synchronously', () => {
    const h = make()
    h.scheduler.notify('x')
    h.scheduler.flush()
    expect(h.apply).toHaveBeenCalledWith('x')

    // the cancelled timer must not fire a second apply
    vi.runAllTimers()
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('flush is a no-op when nothing is pending', () => {
    const h = make()
    h.scheduler.flush()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('parks updates while hidden: no timer, no applies', () => {
    const h = make()
    h.hidden = true
    h.scheduler.notify('x')
    h.scheduler.notify('xy')
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('becoming visible applies exactly once with the latest markdown', () => {
    const h = make()
    h.hidden = true
    h.scheduler.notify('x')
    h.scheduler.notify('xy')
    h.scheduler.notify('xyz')

    h.becomeVisible()
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.apply).toHaveBeenCalledWith('xyz')

    vi.runAllTimers()
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('becoming visible with nothing pending applies nothing', () => {
    const h = make()
    h.hidden = true
    h.becomeVisible()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('flush applies pending markdown even while hidden', () => {
    const h = make()
    h.hidden = true
    h.scheduler.notify('x')
    h.scheduler.flush()
    expect(h.apply).toHaveBeenCalledWith('x')

    // visibility restored later must not double-apply
    h.becomeVisible()
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it('a timer armed while visible re-parks when it fires hidden', () => {
    const h = make()
    h.scheduler.notify('x')
    h.hidden = true // window hides while the debounce timer is armed
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()

    h.hidden = false
    h.becomeVisible()
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.apply).toHaveBeenCalledWith('x')
  })

  it('a hidden park followed by a visible notify times out normally', () => {
    const h = make()
    h.hidden = true
    h.scheduler.notify('x')
    h.hidden = false
    h.scheduler.notify('xy')
    vi.advanceTimersByTime(MIN_PREVIEW_DELAY)
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.apply).toHaveBeenCalledWith('xy')
  })

  it('dispose unsubscribes from visibility and cancels pending work', () => {
    const h = make()
    h.hidden = true
    h.scheduler.notify('x')
    h.scheduler.dispose()
    expect(h.visibleUnsubscribed).toBe(true)

    h.becomeVisible()
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('dispose cancels a scheduled timer', () => {
    const h = make()
    h.scheduler.notify('x')
    h.scheduler.dispose()
    vi.runAllTimers()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('defaults delayFor to previewDelay of the markdown length', () => {
    const apply = vi.fn()
    const s = createPreviewScheduler({
      apply,
      initial: '',
      isHidden: () => false,
      onVisible: () => () => {},
    })
    const big = 'a'.repeat(300_000)
    s.notify(big)
    vi.advanceTimersByTime(MAX_PREVIEW_DELAY - 1)
    expect(apply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(apply).toHaveBeenCalledWith(big)
    s.dispose()
  })
})
