import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import {
  stash,
  take,
  peek,
  evict,
  evictSubtree,
  retarget,
  isCachedDirty,
  anyCachedDirty,
  markCachedSaved,
  dirtyCached,
  reset,
  MAX_CLEAN_CACHED,
  registerViewStateProvider,
  unregisterViewStateProvider,
  captureViewState,
  setPendingViewState,
  consumePendingViewState,
  type CachedBuffer,
  type ViewState,
} from './bufferCache'

/** A clean entry: content sits exactly on the disk baseline. */
function clean(content = 'body'): CachedBuffer {
  return { content, savedContent: content, normalized: null, view: null }
}

/** A dirty entry: content differs from both baselines. */
function dirty(content = 'edited'): CachedBuffer {
  return { content, savedContent: 'body', normalized: null, view: null }
}

beforeEach(() => reset())

describe('stash / take / peek', () => {
  it('round-trips an entry and take() consumes it', () => {
    const entry = dirty()
    stash('/ws/a.md', entry)
    expect(peek('/ws/a.md')).toEqual(entry)
    expect(take('/ws/a.md')).toEqual(entry)
    expect(peek('/ws/a.md')).toBeUndefined()
    expect(take('/ws/a.md')).toBeUndefined()
  })

  it('re-stashing the same path replaces the entry (no duplicates)', () => {
    stash('/ws/a.md', clean('v1'))
    stash('/ws/a.md', clean('v2'))
    expect(peek('/ws/a.md')?.content).toBe('v2')
  })

  it('a normalization-baseline entry reads clean (isDirty semantics)', () => {
    stash('/ws/a.md', { content: '- x\n', savedContent: '* x\n', normalized: '- x\n', view: null })
    expect(isCachedDirty('/ws/a.md')).toBe(false)
  })
})

describe('LRU cap over clean entries', () => {
  it('evicts the oldest CLEAN entry beyond the cap', () => {
    for (let i = 0; i < MAX_CLEAN_CACHED + 1; i++) stash(`/ws/c${i}.md`, clean())
    expect(peek('/ws/c0.md')).toBeUndefined() // oldest clean dropped
    expect(peek(`/ws/c${MAX_CLEAN_CACHED}.md`)).toBeDefined()
  })

  it('never evicts dirty entries, even when they are the oldest', () => {
    stash('/ws/dirty.md', dirty())
    for (let i = 0; i < MAX_CLEAN_CACHED + 3; i++) stash(`/ws/c${i}.md`, clean())
    expect(peek('/ws/dirty.md')).toBeDefined()
    expect(peek('/ws/c0.md')).toBeUndefined()
    expect(peek('/ws/c2.md')).toBeUndefined()
    expect(peek('/ws/c3.md')).toBeDefined()
  })

  it('re-stashing refreshes LRU position', () => {
    for (let i = 0; i < MAX_CLEAN_CACHED; i++) stash(`/ws/c${i}.md`, clean())
    stash('/ws/c0.md', clean('touched')) // move to the newest slot
    stash('/ws/extra.md', clean())
    expect(peek('/ws/c0.md')).toBeDefined()
    expect(peek('/ws/c1.md')).toBeUndefined() // c1 became the oldest
  })
})

describe('evict / evictSubtree', () => {
  it('evict drops exactly the given path', () => {
    stash('/ws/a.md', clean())
    stash('/ws/b.md', clean())
    evict('/ws/a.md')
    expect(peek('/ws/a.md')).toBeUndefined()
    expect(peek('/ws/b.md')).toBeDefined()
  })

  it('evictSubtree is segment-safe: /ws/sub never matches /ws/subfile.md', () => {
    stash('/ws/sub/nested.md', dirty())
    stash('/ws/subfile.md', dirty())
    evictSubtree(['/ws/sub'])
    expect(peek('/ws/sub/nested.md')).toBeUndefined()
    expect(peek('/ws/subfile.md')).toBeDefined()
  })

  it('evictSubtree drops exact matches and every descendant of each path', () => {
    stash('/ws/a.md', clean())
    stash('/ws/dir/x.md', clean())
    stash('/ws/dir/deep/y.md', clean())
    evictSubtree(['/ws/a.md', '/ws/dir'])
    expect(anyCachedDirty()).toEqual([])
    expect(peek('/ws/a.md')).toBeUndefined()
    expect(peek('/ws/dir/x.md')).toBeUndefined()
    expect(peek('/ws/dir/deep/y.md')).toBeUndefined()
  })
})

describe('retarget', () => {
  it('rewrites an exact match and every entry under a moved folder', () => {
    stash('/ws/old.md', dirty('keep me'))
    stash('/ws/dir/x.md', clean())
    retarget('/ws/old.md', '/ws/new.md')
    retarget('/ws/dir', '/ws/moved')
    expect(peek('/ws/new.md')?.content).toBe('keep me')
    expect(peek('/ws/old.md')).toBeUndefined()
    expect(peek('/ws/moved/x.md')).toBeDefined()
    expect(peek('/ws/dir/x.md')).toBeUndefined()
  })

  it('a collision keeps the MOVED entry (its savedContent describes the file now there)', () => {
    stash('/ws/target.md', dirty('stale occupant'))
    stash('/ws/src.md', dirty('moved content'))
    retarget('/ws/src.md', '/ws/target.md')
    expect(peek('/ws/target.md')?.content).toBe('moved content')
    expect(peek('/ws/src.md')).toBeUndefined()
  })

  it('is segment-safe and a no-op for unrelated entries', () => {
    stash('/ws/proj2/a.md', clean())
    retarget('/ws/proj', '/ws/elsewhere')
    expect(peek('/ws/proj2/a.md')).toBeDefined()
  })
})

describe('dirty tracking', () => {
  it('isCachedDirty / anyCachedDirty reflect entry state', () => {
    stash('/ws/c.md', clean())
    stash('/ws/d.md', dirty())
    expect(isCachedDirty('/ws/c.md')).toBe(false)
    expect(isCachedDirty('/ws/d.md')).toBe(true)
    expect(isCachedDirty('/ws/absent.md')).toBe(false)
    expect(anyCachedDirty()).toEqual(['/ws/d.md'])
  })

  it('the dirtyCached store tracks every mutator', () => {
    expect(get(dirtyCached).size).toBe(0)
    stash('/ws/d.md', dirty())
    expect(get(dirtyCached).has('/ws/d.md')).toBe(true)
    retarget('/ws/d.md', '/ws/renamed.md')
    expect(get(dirtyCached).has('/ws/renamed.md')).toBe(true)
    expect(get(dirtyCached).has('/ws/d.md')).toBe(false)
    markCachedSaved('/ws/renamed.md')
    expect(get(dirtyCached).size).toBe(0)
    stash('/ws/e.md', dirty())
    take('/ws/e.md')
    expect(get(dirtyCached).size).toBe(0)
    stash('/ws/f.md', dirty())
    evict('/ws/f.md')
    expect(get(dirtyCached).size).toBe(0)
  })

  it('markCachedSaved adopts content as the disk baseline and voids the normalization', () => {
    stash('/ws/a.md', { content: 'new', savedContent: 'old', normalized: 'norm', view: null })
    markCachedSaved('/ws/a.md')
    expect(peek('/ws/a.md')).toEqual({
      content: 'new',
      savedContent: 'new',
      normalized: null,
      view: null,
    })
    markCachedSaved('/ws/absent.md') // no-op, no throw
  })
})

describe('view-state hand-off', () => {
  const vs: ViewState = { mode: 'wysiwyg', cursor: 12, scroll: 340 }

  it('captureViewState reads the registered provider, null when none or throwing', () => {
    expect(captureViewState()).toBeNull()
    const provider = () => vs
    registerViewStateProvider(provider)
    expect(captureViewState()).toEqual(vs)
    unregisterViewStateProvider(provider)
    expect(captureViewState()).toBeNull()
    registerViewStateProvider(() => {
      throw new Error('boom')
    })
    expect(captureViewState()).toBeNull() // a capture failure never breaks a switch
  })

  it('unregister is identity-gated: a stale onDestroy cannot clear a newer mount', () => {
    const stale = () => vs
    const fresh = () => ({ ...vs, cursor: 99 })
    registerViewStateProvider(stale)
    registerViewStateProvider(fresh)
    unregisterViewStateProvider(stale)
    expect(captureViewState()?.cursor).toBe(99)
  })

  it('consumePendingViewState returns-and-clears only on a mode match', () => {
    setPendingViewState(vs)
    expect(consumePendingViewState('source')).toBeNull() // mismatch: parked, not cleared
    expect(consumePendingViewState('wysiwyg')).toEqual(vs)
    expect(consumePendingViewState('wysiwyg')).toBeNull() // consumed
    setPendingViewState(vs)
    setPendingViewState(null) // openPath resets the slot on every open
    expect(consumePendingViewState('wysiwyg')).toBeNull()
  })
})
