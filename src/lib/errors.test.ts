import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { logPluginMocks } from './test-support/tauriMocks'
import { errorMessage, notice, reportError, reportNotice, clearError, clearNotice } from './errors'

describe('error sink funnel', () => {
  beforeEach(() => {
    logPluginMocks.info.mockClear()
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
})
