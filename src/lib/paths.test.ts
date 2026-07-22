import { describe, it, expect } from 'vitest'
import { isSelfOrDescendant, rewritePrefix } from './paths'

describe('isSelfOrDescendant', () => {
  it('is true for the exact same path', () => {
    expect(isSelfOrDescendant('/ws/docs', '/ws/docs')).toBe(true)
  })

  it('is true for a path nested beneath the ancestor', () => {
    expect(isSelfOrDescendant('/ws/docs/note.md', '/ws/docs')).toBe(true)
  })

  it('is false for a sibling whose name merely shares a prefix', () => {
    expect(isSelfOrDescendant('/ws/docs2/note.md', '/ws/docs')).toBe(false)
  })

  it('is false for an unrelated path', () => {
    expect(isSelfOrDescendant('/ws/other.md', '/ws/docs')).toBe(false)
  })
})

describe('rewritePrefix', () => {
  it('rewrites an exact match to the new prefix', () => {
    expect(rewritePrefix('/ws/old.md', '/ws/old.md', '/ws/new.md')).toBe('/ws/new.md')
  })

  it('rewrites a nested path, keeping the suffix', () => {
    expect(rewritePrefix('/ws/docs/note.md', '/ws/docs', '/ws/archive')).toBe(
      '/ws/archive/note.md',
    )
  })

  it('rewrites a deeply nested path', () => {
    expect(rewritePrefix('/ws/docs/sub/note.md', '/ws/docs', '/ws/renamed')).toBe(
      '/ws/renamed/sub/note.md',
    )
  })

  it('leaves an unrelated path unchanged', () => {
    expect(rewritePrefix('/ws/other.md', '/ws/docs', '/ws/archive')).toBe('/ws/other.md')
  })

  it('is segment-safe: a sibling with a shared name prefix is untouched', () => {
    expect(rewritePrefix('/ws/proj2/file.md', '/ws/proj', '/ws/renamed')).toBe('/ws/proj2/file.md')
  })

  it('is segment-safe on the exact-match boundary too', () => {
    expect(rewritePrefix('/ws/proj2', '/ws/proj', '/ws/renamed')).toBe('/ws/proj2')
  })
})
