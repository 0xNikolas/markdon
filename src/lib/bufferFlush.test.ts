import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerBufferFlush, unregisterBufferFlush, flushBufferEdits } from './bufferFlush'

// Module-singleton slot: every test cleans up its own registration so state
// never leaks into other files sharing the module (files/export/fileSync tests).
let registered: (() => void) | null = null
function use(fn: () => void) {
  registered = fn
  registerBufferFlush(fn)
}
afterEach(() => {
  if (registered) unregisterBufferFlush(registered)
  registered = null
})

describe('bufferFlush', () => {
  it('flushBufferEdits is a no-op with nothing registered', () => {
    expect(() => flushBufferEdits()).not.toThrow()
  })

  it('runs the registered flush on demand', () => {
    const fn = vi.fn()
    use(fn)
    flushBufferEdits()
    flushBufferEdits()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('unregister stops the flush from running', () => {
    const fn = vi.fn()
    use(fn)
    unregisterBufferFlush(fn)
    flushBufferEdits()
    expect(fn).not.toHaveBeenCalled()
  })

  it('a stale unregister does not evict a newer registration (remount-safe)', () => {
    const stale = vi.fn()
    const current = vi.fn()
    registerBufferFlush(stale)
    use(current) // the incoming pane registered before the outgoing destroyed
    unregisterBufferFlush(stale) // outgoing pane's onDestroy
    flushBufferEdits()
    expect(current).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })

  it('a flush that re-enters flushBufferEdits does not recurse', () => {
    let calls = 0
    use(() => {
      calls++
      flushBufferEdits() // must be swallowed by the re-entrancy latch
    })
    flushBufferEdits()
    expect(calls).toBe(1)
  })

  it('re-entrancy latch clears even when the flush throws', () => {
    const boom = () => {
      throw new Error('boom')
    }
    use(boom)
    expect(() => flushBufferEdits()).toThrow('boom')
    const fn = vi.fn()
    use(fn)
    flushBufferEdits() // a poisoned latch would make this a silent no-op
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
