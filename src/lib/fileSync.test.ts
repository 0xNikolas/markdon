import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import { classifyExternalChange, initFileSync, reloadFromDisk } from './fileSync'
import { doc, openDoc, newDoc } from './doc'
import { errorMessage } from './errors'

describe('classifyExternalChange', () => {
  it('ignores when disk matches the buffer (no real change)', () => {
    expect(
      classifyExternalChange({ content: 'x', savedContent: 'x' }, 'x', null),
    ).toBe('ignore')
    expect(
      classifyExternalChange({ content: 'x', savedContent: 'old' }, 'x', null),
    ).toBe('ignore')
  })

  it('ignores our own save landing while the user kept typing', () => {
    // We wrote 'v1'; user has since typed 'v2'. The watcher fires for our own
    // write — disk equals savedContent, so nothing external happened.
    expect(
      classifyExternalChange({ content: 'v2', savedContent: 'v1' }, 'v1', null),
    ).toBe('ignore')
  })

  it('reloads a clean buffer when disk differs', () => {
    expect(
      classifyExternalChange({ content: 'old', savedContent: 'old' }, 'new', null),
    ).toBe('reload')
  })

  it('flags a conflict when a dirty buffer differs from disk', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'theirs', null),
    ).toBe('conflict')
  })

  it('ignores a dirty conflict the user already declined for this exact disk version', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'theirs', 'theirs'),
    ).toBe('ignore')
  })

  it('re-prompts when a new on-disk version arrives after a prior decline', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'newer', 'theirs'),
    ).toBe('conflict')
  })
})

describe('initFileSync', () => {
  beforeEach(() => {
    invoke.mockReset()
    errorMessage.set(null)
    newDoc()
  })

  it('reports an error when watching the file fails', async () => {
    invoke.mockRejectedValue('fsevents unavailable')
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', '# A')
    await vi.waitFor(() => {
      expect(get(errorMessage)).toContain('Could not watch')
    })
    teardown()
  })
})

describe('reloadFromDisk', () => {
  it('preserves the readonly flag and adopts disk content as clean', () => {
    openDoc('/tmp/a.md', 'old', true)
    reloadFromDisk('new')
    const s = get(doc)
    expect(s.readonly).toBe(true)
    expect(s.content).toBe('new')
    expect(s.savedContent).toBe('new')
  })
})
