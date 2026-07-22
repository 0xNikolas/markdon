import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture listen() registrations so tests can fire synthetic event deliveries.
type Handler = (e: { payload: unknown }) => void
const listeners = new Map<string, Handler>()
const listen = vi.fn(async (event: string, handler: Handler) => {
  listeners.set(event, handler)
  return () => listeners.delete(event)
})
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...(a as [string, Handler])) }))

// jsdom has no injected Tauri internals, so currentLabel() falls back to
// 'main' via its try/catch — mock getCurrentWindow to control the label.
let windowLabel = 'main'
const setTitle = vi.fn<(title: string) => Promise<void>>(() => Promise.resolve())
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: windowLabel, setTitle }),
}))

import { isForWindow, listenScoped, currentLabel, setWindowTitle } from './windowing'

beforeEach(() => {
  listeners.clear()
  listen.mockClear()
  setTitle.mockClear()
  windowLabel = 'main'
})

describe('isForWindow', () => {
  it('passes untargeted deliveries through (single-window / broadcast events)', () => {
    expect(isForWindow(undefined, 'main')).toBe(true)
    expect(isForWindow(null, 'doc-1')).toBe(true)
  })

  it("passes a delivery targeted at this window's own label", () => {
    expect(isForWindow('doc-2', 'doc-2')).toBe(true)
    expect(isForWindow('main', 'main')).toBe(true)
  })

  it("drops a delivery targeted at a DIFFERENT window's label", () => {
    // The amendment-#8 case: emit_to scoping failed (or a broadcast leaked) and
    // doc-1's payload reached doc-2 — the filter must silently drop it.
    expect(isForWindow('doc-1', 'doc-2')).toBe(false)
    expect(isForWindow('doc-1', 'main')).toBe(false)
  })
})

describe('listenScoped', () => {
  it('invokes the handler for a delivery targeted at this window', async () => {
    windowLabel = 'doc-3'
    const handler = vi.fn()
    await listenScoped('menu:save', handler)
    listeners.get('menu:save')!({ payload: { target: 'doc-3' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("drops a delivery carrying another window's label", async () => {
    windowLabel = 'doc-3'
    const handler = vi.fn()
    await listenScoped('menu:save', handler)
    listeners.get('menu:save')!({ payload: { target: 'main' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('invokes the handler for untargeted and null payloads', async () => {
    const handler = vi.fn()
    await listenScoped('file:opened', handler)
    listeners.get('file:opened')!({ payload: null })
    listeners.get('file:opened')!({ payload: {} })
    expect(handler).toHaveBeenCalledTimes(2)
  })
})

describe('currentLabel', () => {
  it("returns this window's label from the Tauri window handle", () => {
    windowLabel = 'doc-7'
    expect(currentLabel()).toBe('doc-7')
  })
})

describe('setWindowTitle', () => {
  it("forwards the title to this window's handle", () => {
    setWindowTitle('a.md — Markdon')
    expect(setTitle).toHaveBeenCalledWith('a.md — Markdon')
  })

  it('does not throw when the Tauri handle is unavailable (jsdom fallback)', () => {
    setTitle.mockImplementationOnce(() => {
      throw new Error('no Tauri internals')
    })
    expect(() => setWindowTitle('x — Markdon')).not.toThrow()
  })

  it('swallows an async setTitle rejection', async () => {
    setTitle.mockRejectedValueOnce(new Error('ipc down'))
    setWindowTitle('x — Markdon')
    // Flush the microtask queue: an unhandled rejection would fail the run.
    await Promise.resolve()
  })
})
