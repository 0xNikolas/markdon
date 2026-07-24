import { describe, it, expect } from 'vitest'
import {
  isSelfOrDescendant,
  rewritePrefix,
  ancestorDirs,
  joinRelative,
  basename,
  dirname,
  splitExt,
  fileBreadcrumb,
  isInsideRoot,
  windowTitle,
} from './paths'

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

describe('basename', () => {
  it('returns the final segment of an absolute path', () => {
    expect(basename('/ws/a/b.md')).toBe('b.md')
  })

  it('ignores a trailing slash (segment-based, not lastIndexOf)', () => {
    expect(basename('/ws/dir/')).toBe('dir')
  })

  it('returns a bare name unchanged', () => {
    expect(basename('name.md')).toBe('name.md')
  })

  it('returns the segment for a root-level file', () => {
    expect(basename('/x.png')).toBe('x.png')
  })

  it('yields empty for the root and the empty string', () => {
    expect(basename('/')).toBe('')
    expect(basename('')).toBe('')
  })
})

describe('dirname', () => {
  it('returns the parent directory with no trailing slash', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b')
  })

  it('returns empty for a root-level file (never "/")', () => {
    expect(dirname('/x.png')).toBe('')
    expect(dirname('/a')).toBe('')
  })

  it('returns empty for a bare segment', () => {
    expect(dirname('a')).toBe('')
  })

  it('returns the parent for a relative two-segment path', () => {
    expect(dirname('a/b')).toBe('a')
  })
})

describe('splitExt', () => {
  it('splits stem and extension on the last non-leading dot', () => {
    expect(splitExt('notes.md')).toEqual({ stem: 'notes', ext: 'md' })
  })

  it('treats only the last dot as the extension boundary', () => {
    expect(splitExt('notes.v2.md')).toEqual({ stem: 'notes.v2', ext: 'md' })
  })

  it('gives a leading-dot dotfile no extension', () => {
    expect(splitExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' })
  })

  it('gives an extension-less name an empty ext', () => {
    expect(splitExt('README')).toEqual({ stem: 'README', ext: '' })
  })
})

describe('isInsideRoot', () => {
  it('is true for a file at or nested under the root', () => {
    expect(isInsideRoot('/ws/project/file.md', '/ws/project')).toBe(true)
    expect(isInsideRoot('/ws/project/sub/folders/file.md', '/ws/project')).toBe(true)
  })

  it('is false for a path outside the root', () => {
    expect(isInsideRoot('/Users/nicu/other/todo.md', '/ws/project')).toBe(false)
  })

  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    // /ws/proj is NOT an ancestor of /ws/project2 even though the string is a prefix.
    expect(isInsideRoot('/ws/project2/file.md', '/ws/proj')).toBe(false)
  })

  it('is false for a segment-less root (would otherwise vacuously match everything)', () => {
    expect(isInsideRoot('/Users/nicu/notes/secret.md', '/')).toBe(false)
    expect(isInsideRoot('/Users/nicu/notes/secret.md', '')).toBe(false)
  })
})

describe('fileBreadcrumb', () => {
  it('is just "Untitled" with no crumbs for a null path', () => {
    expect(fileBreadcrumb(null, null, null)).toEqual({ crumbs: [], filename: 'Untitled' })
    expect(fileBreadcrumb(null, '/ws/project', 'project')).toEqual({ crumbs: [], filename: 'Untitled' })
  })

  it('splits a workspace file into root name + intermediate folders + filename', () => {
    expect(fileBreadcrumb('/ws/project/sub/folders/filename.md', '/ws/project', 'project')).toEqual({
      crumbs: ['project', 'sub', 'folders'],
      filename: 'filename.md',
    })
  })

  it('has no intermediate crumbs for a file exactly at the workspace root', () => {
    expect(fileBreadcrumb('/ws/project/filename.md', '/ws/project', 'project')).toEqual({
      crumbs: ['project'],
      filename: 'filename.md',
    })
  })

  it('falls back to parent-folder + filename when there is no open workspace', () => {
    expect(fileBreadcrumb('/Users/nicu/notes/todo.md', null, null)).toEqual({
      crumbs: ['notes'],
      filename: 'todo.md',
    })
  })

  it('falls back to parent-folder + filename for a path outside the open workspace', () => {
    expect(fileBreadcrumb('/Users/nicu/other/todo.md', '/ws/project', 'project')).toEqual({
      crumbs: ['other'],
      filename: 'todo.md',
    })
  })

  it('does not treat a sibling directory sharing a name prefix as inside the workspace', () => {
    // /ws/proj is NOT an ancestor of /ws/project2 even though the string is a prefix.
    expect(fileBreadcrumb('/ws/project2/file.md', '/ws/proj', 'proj')).toEqual({
      crumbs: ['project2'],
      filename: 'file.md',
    })
  })

  it('has no crumbs for a top-level file with no parent folder in its path', () => {
    expect(fileBreadcrumb('todo.md', null, null)).toEqual({ crumbs: [], filename: 'todo.md' })
  })

  it('never leaks full ancestry when the workspace root has no path segments', () => {
    // Root '/' (or '') would make the ancestry check vacuously true; must fall
    // back to the parent-only form instead of exposing the whole path.
    expect(fileBreadcrumb('/Users/nicu/notes/secret.md', '/', 'Macintosh HD')).toEqual({
      crumbs: ['notes'],
      filename: 'secret.md',
    })
    expect(fileBreadcrumb('/Users/nicu/notes/secret.md', '', 'x')).toEqual({
      crumbs: ['notes'],
      filename: 'secret.md',
    })
  })
})

describe('windowTitle', () => {
  it('shows "Untitled" for a null path', () => {
    expect(windowTitle(null, false)).toBe('Untitled — Markdon')
  })

  it('shows the filename for a clean doc', () => {
    expect(windowTitle('/ws/notes/a.md', false)).toBe('a.md — Markdon')
  })

  it('prefixes a bullet while the doc is dirty', () => {
    expect(windowTitle('/ws/notes/a.md', true)).toBe('• a.md — Markdon')
    expect(windowTitle(null, true)).toBe('• Untitled — Markdon')
  })

  it('falls back safely on trailing-slash and segment-less paths', () => {
    // Mirrors fileBreadcrumb's segment filtering: empty segments never surface.
    expect(windowTitle('/ws/notes/', false)).toBe('notes — Markdon')
    expect(windowTitle('/', false)).toBe('Untitled — Markdon')
  })

  it('renders plain "Markdon" while the empty page is shown — empty wins over everything', () => {
    expect(windowTitle(null, false, true)).toBe('Markdon')
    // The empty page implies a pristine pathless doc, but stale-looking
    // inputs must not leak a filename or bullet either.
    expect(windowTitle('/ws/a.md', true, true)).toBe('Markdon')
  })
})
