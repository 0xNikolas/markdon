import { describe, it, expect, beforeEach } from 'vitest'
import { readonlyMemory } from './readonlyMemory'

describe('readonlyMemory', () => {
  beforeEach(() => readonlyMemory.reset())

  it('has is false for an unknown path', () => {
    expect(readonlyMemory.has('/tmp/a.md')).toBe(false)
  })

  it('lock then has returns true; unlock clears it', () => {
    readonlyMemory.lock('/tmp/a.md')
    expect(readonlyMemory.has('/tmp/a.md')).toBe(true)
    readonlyMemory.unlock('/tmp/a.md')
    expect(readonlyMemory.has('/tmp/a.md')).toBe(false)
  })

  it('lock is idempotent and independent per path', () => {
    readonlyMemory.lock('/tmp/a.md')
    readonlyMemory.lock('/tmp/a.md')
    readonlyMemory.lock('/tmp/b.md')
    expect(readonlyMemory.has('/tmp/a.md')).toBe(true)
    expect(readonlyMemory.has('/tmp/b.md')).toBe(true)
  })

  it('reset forgets everything', () => {
    readonlyMemory.lock('/tmp/a.md')
    readonlyMemory.lock('/tmp/b.md')
    readonlyMemory.reset()
    expect(readonlyMemory.has('/tmp/a.md')).toBe(false)
    expect(readonlyMemory.has('/tmp/b.md')).toBe(false)
  })

  describe('retarget', () => {
    it('moves an exact-match lock to the new path', () => {
      readonlyMemory.lock('/tmp/a.md')
      readonlyMemory.retarget('/tmp/a.md', '/tmp/renamed.md')
      expect(readonlyMemory.has('/tmp/a.md')).toBe(false)
      expect(readonlyMemory.has('/tmp/renamed.md')).toBe(true)
    })

    it('rewrites a lock nested beneath a moved folder', () => {
      readonlyMemory.lock('/ws/docs/a.md')
      readonlyMemory.retarget('/ws/docs', '/ws/notes')
      expect(readonlyMemory.has('/ws/docs/a.md')).toBe(false)
      expect(readonlyMemory.has('/ws/notes/a.md')).toBe(true)
    })

    it('is segment-safe: a sibling with a shared string prefix is untouched', () => {
      readonlyMemory.lock('/ws/proj2/a.md')
      readonlyMemory.retarget('/ws/proj', '/ws/renamed')
      expect(readonlyMemory.has('/ws/proj2/a.md')).toBe(true)
    })

    it('leaves unrelated locks untouched', () => {
      readonlyMemory.lock('/tmp/other.md')
      readonlyMemory.retarget('/tmp/a.md', '/tmp/renamed.md')
      expect(readonlyMemory.has('/tmp/other.md')).toBe(true)
    })
  })

  describe('forget', () => {
    it('unlocks an exact-match path', () => {
      readonlyMemory.lock('/tmp/a.md')
      readonlyMemory.forget(['/tmp/a.md'])
      expect(readonlyMemory.has('/tmp/a.md')).toBe(false)
    })

    it('unlocks every descendant of a given folder path', () => {
      readonlyMemory.lock('/ws/docs/a.md')
      readonlyMemory.lock('/ws/docs/sub/b.md')
      readonlyMemory.lock('/ws/keep.md')
      readonlyMemory.forget(['/ws/docs'])
      expect(readonlyMemory.has('/ws/docs/a.md')).toBe(false)
      expect(readonlyMemory.has('/ws/docs/sub/b.md')).toBe(false)
      expect(readonlyMemory.has('/ws/keep.md')).toBe(true)
    })

    it('is segment-safe: a sibling with a shared string prefix survives', () => {
      readonlyMemory.lock('/ws/docs2/a.md')
      readonlyMemory.forget(['/ws/docs'])
      expect(readonlyMemory.has('/ws/docs2/a.md')).toBe(true)
    })

    it('handles multiple given paths at once', () => {
      readonlyMemory.lock('/ws/a.md')
      readonlyMemory.lock('/ws/b.md')
      readonlyMemory.lock('/ws/c.md')
      readonlyMemory.forget(['/ws/a.md', '/ws/b.md'])
      expect(readonlyMemory.has('/ws/a.md')).toBe(false)
      expect(readonlyMemory.has('/ws/b.md')).toBe(false)
      expect(readonlyMemory.has('/ws/c.md')).toBe(true)
    })

    it('is a no-op on an empty list', () => {
      readonlyMemory.lock('/ws/a.md')
      readonlyMemory.forget([])
      expect(readonlyMemory.has('/ws/a.md')).toBe(true)
    })
  })
})
