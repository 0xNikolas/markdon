import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { logPluginMocks } from './test-support/tauriMocks'
import { formatUnknown, logInfo, logWarn, logError, installGlobalErrorSink } from './logging'

// logging.ts echoes every line to the console methods it captured at module
// load; silence those (spy on the prototype-bound originals is impossible from
// here, so we just accept the echo — tests assert on the plugin spies).

describe('formatUnknown', () => {
  it('renders an Error with its stack', () => {
    const e = new Error('boom')
    const out = formatUnknown(e)
    expect(out.startsWith('boom')).toBe(true)
    expect(out).toContain('\n')
    expect(out).toContain(e.stack!)
  })

  it('renders an Error without a stack as just the message', () => {
    const e = new Error('bare')
    e.stack = undefined
    expect(formatUnknown(e)).toBe('bare')
  })

  it('stringifies non-Error values', () => {
    expect(formatUnknown('plain')).toBe('plain')
    expect(formatUnknown(42)).toBe('42')
    expect(formatUnknown({ a: 1 })).toBe('[object Object]')
    expect(formatUnknown(null)).toBe('null')
  })
})

describe('log functions', () => {
  beforeEach(() => {
    logPluginMocks.info.mockClear()
    logPluginMocks.warn.mockClear()
    logPluginMocks.error.mockClear()
  })

  it('logInfo forwards the message to the plugin info sink', () => {
    logInfo('hello')
    expectOnceWith(logPluginMocks.info, 'hello')
  })

  it('logWarn/logError append the formatted error to the message', () => {
    const e = new Error('cause')
    e.stack = undefined
    logWarn('warned', e)
    logError('failed', e)
    expectOnceWith(logPluginMocks.warn, 'warned: cause')
    expectOnceWith(logPluginMocks.error, 'failed: cause')
  })

  it('omits the suffix when no error is given', () => {
    logError('solo')
    expectOnceWith(logPluginMocks.error, 'solo')
  })

  it('swallows a rejecting plugin call (never an unhandled rejection)', async () => {
    logPluginMocks.error.mockRejectedValueOnce(new Error('ipc down'))
    expect(() => logError('x')).not.toThrow()
    // Let the rejection settle; vitest fails the test on unhandled rejections.
    await new Promise((r) => setTimeout(r, 0))
  })

  it('swallows a plugin call that throws synchronously', () => {
    logPluginMocks.error.mockImplementationOnce(() => {
      throw new Error('no __TAURI_INTERNALS__')
    })
    expect(() => logError('x')).not.toThrow()
  })
})

/** Assert `spy` was called exactly once, with exactly `arg`. */
function expectOnceWith(spy: { mock: { calls: unknown[][] } }, arg: string): void {
  expect(spy.mock.calls).toEqual([[arg]])
}

/** Minimal EventTarget-like stub recording listeners, with a dispatch helper. */
function makeTarget() {
  const listeners = new Map<string, Set<(ev: Event) => void>>()
  return {
    addEventListener: vi.fn((type: string, fn: EventListenerOrEventListenerObject) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn as (ev: Event) => void)
    }),
    removeEventListener: vi.fn((type: string, fn: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(fn as (ev: Event) => void)
    }),
    dispatch(type: string, ev: object) {
      for (const fn of listeners.get(type) ?? []) fn(ev as Event)
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

describe('installGlobalErrorSink', () => {
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    logPluginMocks.warn.mockClear()
    logPluginMocks.error.mockClear()
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
  })

  it('routes console.error through the plugin exactly once (no recursion)', () => {
    const before = console.error
    uninstall = installGlobalErrorSink(undefined)
    expect(console.error).not.toBe(before)
    console.error('kaput')
    expectOnceWith(logPluginMocks.error, 'kaput')
    console.warn('meh', new Error('why'))
    expect(logPluginMocks.warn).toHaveBeenCalledTimes(1)
    expect(logPluginMocks.warn.mock.calls[0][0]).toMatch(/^meh why/)
  })

  it('is idempotent: a second install is a no-op and its uninstall changes nothing', () => {
    uninstall = installGlobalErrorSink(undefined)
    const wrapped = console.error
    const secondUninstall = installGlobalErrorSink(undefined)
    expect(console.error).toBe(wrapped)
    secondUninstall()
    expect(console.error).toBe(wrapped) // the real install is still active
  })

  it('uninstall restores the original console methods and listeners', () => {
    const origError = console.error
    const origWarn = console.warn
    const target = makeTarget()
    uninstall = installGlobalErrorSink(target)
    expect(target.count('error')).toBe(1)
    expect(target.count('unhandledrejection')).toBe(1)
    uninstall()
    uninstall = null
    expect(console.error).toBe(origError)
    expect(console.warn).toBe(origWarn)
    expect(target.count('error')).toBe(0)
    expect(target.count('unhandledrejection')).toBe(0)
  })

  it('logs uncaught errors from the target with location and cause', () => {
    const target = makeTarget()
    uninstall = installGlobalErrorSink(target)
    const cause = new Error('deep')
    cause.stack = undefined
    target.dispatch('error', {
      message: 'deep',
      filename: 'app.js',
      lineno: 3,
      colno: 7,
      error: cause,
    })
    expectOnceWith(logPluginMocks.error, 'Uncaught error: deep (app.js:3:7): deep')
  })

  it('logs unhandled promise rejections with the formatted reason', () => {
    const target = makeTarget()
    uninstall = installGlobalErrorSink(target)
    target.dispatch('unhandledrejection', { reason: 'nope' })
    expectOnceWith(logPluginMocks.error, 'Unhandled promise rejection: nope')
  })

  it('installs without window access when target is undefined (node env)', () => {
    expect(typeof window).toBe('undefined')
    uninstall = installGlobalErrorSink() // default parameter path
    console.error('still routed')
    expectOnceWith(logPluginMocks.error, 'still routed')
  })
})
