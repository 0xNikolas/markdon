import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import {
  classifyExternalChange,
  initFileSync,
  reloadFromDisk,
  reconcileWithDisk,
  conflict,
  dismissConflict,
} from './fileSync'
import { doc, openDoc, newDoc, edit, isDirty, restoreDoc, resetReadonlyMemory } from './doc'
import { errorMessage } from './errors'
import { watchStatus } from './ui'

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

  it('reloads a normalization-clean buffer when disk differs (not a conflict)', () => {
    // The editor re-serialized the loaded content ('* x' -> '- x') but the
    // user typed nothing: content !== savedContent yet the buffer is logically
    // clean, so an external change silently reloads instead of prompting.
    expect(
      classifyExternalChange(
        { content: '- x\n', savedContent: '* x\n', normalized: '- x\n' },
        'external\n',
        null,
      ),
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
    watchStatus.set('idle')
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

  it("sets watchStatus 'watching' once watch_file resolves", async () => {
    invoke.mockResolvedValue(undefined)
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', '# A')
    await vi.waitFor(() => {
      expect(get(watchStatus)).toBe('watching')
    })
    teardown()
  })

  it("stays 'idle' for a null path", async () => {
    invoke.mockResolvedValue(undefined)
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', '# A')
    await vi.waitFor(() => expect(get(watchStatus)).toBe('watching'))
    newDoc() // path -> null
    expect(get(watchStatus)).toBe('idle')
    teardown()
  })

  it("returns to 'idle' when watch_file rejects (error still reported)", async () => {
    invoke.mockRejectedValue('fsevents unavailable')
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', '# A')
    await vi.waitFor(() => expect(get(errorMessage)).toContain('Could not watch'))
    expect(get(watchStatus)).toBe('idle')
    teardown()
  })

  it("teardown resets watchStatus to 'idle'", async () => {
    invoke.mockResolvedValue(undefined)
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', '# A')
    await vi.waitFor(() => expect(get(watchStatus)).toBe('watching'))
    teardown()
    expect(get(watchStatus)).toBe('idle')
  })

  it('does not mark a stale path as watching after a mid-flight switch', async () => {
    const resolvers = new Map<string, () => void>()
    invoke.mockImplementation((cmd: unknown, args?: unknown) => {
      if (cmd === 'watch_file')
        return new Promise<void>((res) => {
          resolvers.set((args as { path: string }).path, () => res())
        })
      return Promise.resolve()
    })
    const teardown = await initFileSync()
    openDoc('/tmp/a.md', 'a')
    openDoc('/tmp/b.md', 'b') // switch while a's watch is still in flight
    resolvers.get('/tmp/a.md')!()
    await Promise.resolve()
    await Promise.resolve()
    expect(get(watchStatus)).toBe('idle') // stale resolve must not flip it
    resolvers.get('/tmp/b.md')!()
    await vi.waitFor(() => expect(get(watchStatus)).toBe('watching'))
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

describe('reconcileWithDisk', () => {
  beforeEach(() => {
    invoke.mockReset()
    conflict.set(null)
    resetReadonlyMemory() // an earlier readonly open must not lock these paths
    newDoc()
  })

  it('silently reloads a clean buffer when disk differs', async () => {
    openDoc('/tmp/a.md', 'old')
    invoke.mockResolvedValue('newer')
    await reconcileWithDisk('/tmp/a.md')
    const s = get(doc)
    expect(s.content).toBe('newer')
    expect(s.savedContent).toBe('newer')
    expect(get(conflict)).toBeNull()
    // The silent adopt is recorded to File History (recoverable overwrite).
    expect(invoke).toHaveBeenCalledWith('record_history', {
      path: '/tmp/a.md',
      trigger: 'external',
    })
  })

  it('raises the conflict bar for a dirty buffer', async () => {
    openDoc('/tmp/a.md', 'base')
    edit('mine')
    invoke.mockResolvedValue('theirs')
    await reconcileWithDisk('/tmp/a.md')
    expect(get(conflict)).toBe('theirs')
    expect(get(doc).content).toBe('mine') // buffer untouched until the user decides
  })

  it('ignores when disk matches savedContent (our own write landing)', async () => {
    openDoc('/tmp/a.md', 'base')
    edit('mine')
    invoke.mockResolvedValue('base')
    await reconcileWithDisk('/tmp/a.md')
    expect(get(conflict)).toBeNull()
    expect(isDirty(get(doc))).toBe(true)
  })

  it('respects a prior decline of this exact disk version', async () => {
    openDoc('/tmp/a.md', 'base')
    edit('mine')
    invoke.mockResolvedValue('theirs')
    await reconcileWithDisk('/tmp/a.md')
    expect(get(conflict)).toBe('theirs')
    dismissConflict() // "Keep mine"
    await reconcileWithDisk('/tmp/a.md')
    expect(get(conflict)).toBeNull() // no re-prompt for the declined version
  })

  it('no-ops when the doc is not (or no longer) at the given path', async () => {
    openDoc('/tmp/other.md', 'x')
    invoke.mockResolvedValue('newer')
    await reconcileWithDisk('/tmp/a.md')
    expect(invoke).not.toHaveBeenCalledWith('read_file', { path: '/tmp/a.md' })
    expect(get(doc).content).toBe('x')
  })

  it('drops a read that resolves after the user switched away (path re-check)', async () => {
    openDoc('/tmp/a.md', 'old')
    let resolveRead!: (v: string) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'read_file'
        ? new Promise<string>((res) => {
            resolveRead = res
          })
        : Promise.resolve(),
    )
    const p = reconcileWithDisk('/tmp/a.md')
    openDoc('/tmp/b.md', 'b') // switch while the read is in flight
    resolveRead('newer')
    await p
    expect(get(doc).content).toBe('b')
    expect(get(conflict)).toBeNull()
  })

  it('drops a read that resolves after a switch-away-AND-back (loadId re-check)', async () => {
    openDoc('/tmp/a.md', 'old')
    let resolveRead!: (v: string) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'read_file'
        ? new Promise<string>((res) => {
            resolveRead = res
          })
        : Promise.resolve(),
    )
    const p = reconcileWithDisk('/tmp/a.md')
    // A second stash/restore of the SAME path while the read is in flight:
    // same path, newer loadId — the stale read must not classify against it.
    restoreDoc('/tmp/a.md', { content: 'restored', savedContent: 'restored', normalized: null })
    resolveRead('stale disk snapshot')
    await p
    expect(get(doc).content).toBe('restored')
    expect(get(conflict)).toBeNull()
  })

  it('swallows a read failure (file mid-write or removed)', async () => {
    openDoc('/tmp/a.md', 'old')
    invoke.mockRejectedValue('mid-write')
    await expect(reconcileWithDisk('/tmp/a.md')).resolves.toBeUndefined()
    expect(get(doc).content).toBe('old')
    expect(get(conflict)).toBeNull()
  })
})
