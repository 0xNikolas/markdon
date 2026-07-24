import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesce } from './coalesce'

describe('coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs fn once on the trailing edge after schedule()', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(249)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst of schedule() calls into ONE fn()', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    c.schedule()
    c.schedule()
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('re-arms the timer on each schedule() (trailing edge, not leading)', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    vi.advanceTimersByTime(200)
    c.schedule() // resets the 250ms window
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush() runs a pending fn() synchronously and clears the timer', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    c.flush()
    expect(fn).toHaveBeenCalledTimes(1)
    // Timer was cleared: advancing does not fire again.
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('flush() is a no-op when nothing is pending', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.flush()
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel() drops a pending fn() WITHOUT running it', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    c.cancel()
    vi.advanceTimersByTime(250)
    expect(fn).not.toHaveBeenCalled()
  })

  it('schedule() after a fired timer re-arms for another run', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 250)
    c.schedule()
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(1)
    c.schedule()
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
