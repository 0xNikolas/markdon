import { describe, it, expect } from 'vitest'
import { isSelfOrDescendant, rewritePrefix, ancestorDirs, joinRelative } from './paths'

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

describe('ancestorDirs', () => {
  it('lists every dir strictly between root and path, outermost first', () => {
    expect(ancestorDirs('/ws', '/ws/a/b/c.md')).toEqual(['/ws/a', '/ws/a/b'])
  })

  it('a direct child of the root has no ancestors to expand', () => {
    expect(ancestorDirs('/ws', '/ws/note.md')).toEqual([])
  })

  it('excludes the path itself (a folder rename target is not its own ancestor)', () => {
    expect(ancestorDirs('/ws', '/ws/a/b')).toEqual(['/ws/a'])
  })

  it('a path outside the root yields nothing', () => {
    expect(ancestorDirs('/ws', '/elsewhere/a/b.md')).toEqual([])
  })

  it('is segment-safe: a sibling sharing the root as a name prefix yields nothing', () => {
    expect(ancestorDirs('/ws', '/ws2/a/b.md')).toEqual([])
  })

  it('the root itself yields nothing', () => {
    expect(ancestorDirs('/ws', '/ws')).toEqual([])
  })
})

describe('joinRelative', () => {
  it('joins a bare name', () => {
    expect(joinRelative('/ws/notes', 'x.png')).toBe('/ws/notes/x.png')
  })

  it('drops a leading ./ segment', () => {
    expect(joinRelative('/ws/notes', './x.png')).toBe('/ws/notes/x.png')
  })

  it('joins a subdirectory path', () => {
    expect(joinRelative('/ws/notes', 'img/x.png')).toBe('/ws/notes/img/x.png')
  })

  it('resolves ../ into the parent directory', () => {
    expect(joinRelative('/ws/notes', '../img/x.png')).toBe('/ws/img/x.png')
  })

  it('clamps ../ escapes at the filesystem root', () => {
    expect(joinRelative('/ws', '../../../x.png')).toBe('/x.png')
  })

  it('normalizes interior ./ segments', () => {
    expect(joinRelative('/ws', 'a/./b/x.png')).toBe('/ws/a/b/x.png')
  })

  it('tolerates a trailing slash on the directory', () => {
    expect(joinRelative('/ws/notes/', 'x.png')).toBe('/ws/notes/x.png')
  })

  it('collapses doubled slashes in the relative part', () => {
    expect(joinRelative('/ws', 'img//x.png')).toBe('/ws/img/x.png')
  })
})
