import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  relativeTime,
  formatBytes,
  sizeDelta,
  triggerLabel,
  loadVersions,
  recordSave,
  recordExternal,
  recordRevert,
  versions,
  type HistoryEntry,
} from './history'

describe('relativeTime', () => {
  const now = 1_000_000_000
  it('shows "just now" under a minute', () => {
    expect(relativeTime(now, now)).toBe('just now')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
  })
  it('clamps a future timestamp to "just now"', () => {
    expect(relativeTime(now + 5_000, now)).toBe('just now')
  })
  it('shows minutes, hours, days', () => {
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe('5d ago')
  })
})

describe('formatBytes', () => {
  it('uses integer bytes under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(142)).toBe('142 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })
  it('rounds to one decimal in KB and MB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })
})

describe('sizeDelta', () => {
  it('renders an em dash for the first version', () => {
    expect(sizeDelta(500, null)).toBe('—')
  })
  it('renders an em dash for no change', () => {
    expect(sizeDelta(500, 500)).toBe('—')
  })
  it('signs positive and negative deltas', () => {
    expect(sizeDelta(642, 500)).toBe('+142 B')
    expect(sizeDelta(500, 642)).toBe('-142 B')
    expect(sizeDelta(2048, 1024)).toBe('+1.0 KB')
  })
})

describe('triggerLabel', () => {
  it('maps each trigger to its badge', () => {
    expect(triggerLabel('save')).toBe('Saved')
    expect(triggerLabel('external')).toBe('External')
    expect(triggerLabel('revert')).toBe('Reverted')
  })
})

describe('loadVersions', () => {
  beforeEach(() => {
    invoke.mockReset()
    versions.set([])
  })
  it('invokes list_history and stores the result newest-first as Rust returns it', async () => {
    const rows: HistoryEntry[] = [
      { id: '3.md', ts: 3, size: 30, hash: 'c', preview: 'v3', trigger: 'save' },
      { id: '2.md', ts: 2, size: 20, hash: 'b', preview: 'v2', trigger: 'external' },
      { id: '1.md', ts: 1, size: 10, hash: 'a', preview: 'v1', trigger: 'save' },
    ]
    invoke.mockResolvedValue(rows)
    const out = await loadVersions('/ws/a.md')
    expect(invoke).toHaveBeenCalledWith('list_history', { path: '/ws/a.md' })
    expect(out.map((v) => v.ts)).toEqual([3, 2, 1])
    expect(get(versions)).toEqual(rows)
  })
})

// NB: deliberately no beforeEach(mockReset) here. A within-test promise
// rejection combined with a beforeEach hook trips vitest 2.x's
// unhandledRejection tracker into failing the test even though the rejection IS
// caught (verified: identical assertions pass without the hook). Each test sets
// its own mockRejectedValue inline, and toHaveBeenCalledWith is order-agnostic.
describe('record wrappers swallow rejections', () => {
  it('recordSave resolves undefined (never throws) even when invoke rejects', async () => {
    invoke.mockRejectedValue('disk gone')
    const result = await recordSave('/ws/a.md') // must not throw
    expect(result).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('record_history', { path: '/ws/a.md', trigger: 'save' })
  })
  it('recordExternal and recordRevert pass their trigger and swallow rejection', async () => {
    invoke.mockRejectedValue('nope')
    await recordExternal('/ws/a.md') // must not throw
    await recordRevert('/ws/a.md') // must not throw
    expect(invoke).toHaveBeenCalledWith('record_history', { path: '/ws/a.md', trigger: 'external' })
    expect(invoke).toHaveBeenCalledWith('record_history', { path: '/ws/a.md', trigger: 'revert' })
  })
})
