import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { invoke, logPluginMocks } from './test-support/tauriMocks'
import {
  errorMessage,
  notice,
  reportError,
  reportFailure,
  reportNotice,
  clearError,
  clearNotice,
  revealLog,
} from './errors'

describe('error sink funnel', () => {
  beforeEach(() => {
    invoke.mockReset()
    logPluginMocks.info.mockClear()
    logPluginMocks.warn.mockClear()
    logPluginMocks.error.mockClear()
    clearError()
    clearNotice()
  })

  it('reportError sets the banner store AND persists via the log plugin', () => {
    reportError('Could not save file: disk full')
    expect(get(errorMessage)).toBe('Could not save file: disk full')
    expect(logPluginMocks.error.mock.calls).toEqual([['Could not save file: disk full']])
  })

  it('reportNotice sets the notice store AND logs at info level', () => {
    reportNotice('File was detached')
    expect(get(notice)).toBe('File was detached')
    expect(logPluginMocks.info.mock.calls).toEqual([['File was detached']])
  })

  it('clearError/clearNotice do not log', () => {
    clearError()
    clearNotice()
    expect(logPluginMocks.error).not.toHaveBeenCalled()
    expect(logPluginMocks.info).not.toHaveBeenCalled()
  })

  it('revealLog invokes reveal_log_file exactly once, with no args', () => {
    invoke.mockResolvedValue(null)
    revealLog()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('reveal_log_file')
  })

  it('revealLog swallows a rejection into logWarn — never a banner (no re-fail loop)', async () => {
    invoke.mockRejectedValueOnce('nope')
    revealLog()
    // Flush the microtask queue: an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0))
    expect(logPluginMocks.warn.mock.calls).toEqual([['Could not reveal log file: nope']])
    expect(get(errorMessage)).toBeNull()
  })

  it('reportFailure renders a string reject verbatim — byte-identical to the old String(e) shape', () => {
    reportFailure('save file', 'disk full')
    expect(get(errorMessage)).toBe('Could not save file: disk full')
    expect(logPluginMocks.error.mock.calls).toEqual([['Could not save file: disk full']])
  })

  it('reportFailure carries an Error message and stack into banner and log', () => {
    const e = new Error('boom')
    reportFailure('save file', e)
    const msg = get(errorMessage)!
    expect(msg).toContain('Could not save file: boom')
    expect(msg).toContain(e.stack!)
    expect(logPluginMocks.error.mock.calls).toEqual([[msg]])
  })
})
