import { describe, it, expect } from 'vitest'
import {
  leafNameError,
  visibleRowPaths,
  folderPaths,
  folderRows,
  firstMarkdownPath,
  pasteTargetDir,
} from './fileTree'
import { tree, dir, file } from './test-support/workspaceFixtures'

describe('leafNameError', () => {
  it.each(['note.md', 'README', '.hidden', '..twodots', 'a b c.markdown'])(
    'accepts %s',
    (name) => {
      expect(leafNameError(name)).toBeNull()
    },
  )

  it.each(['', '   ', '\t'])('rejects blank input %j', (name) => {
    expect(leafNameError(name)).toContain('empty')
  })

  it.each(['.', '..'])('rejects the path special %s', (name) => {
    expect(leafNameError(name)).toContain('not a valid name')
  })

  it.each(['a/b.md', '/abs.md', 'a\\b.md'])('rejects separator-bearing %s', (name) => {
    expect(leafNameError(name)).toContain('cannot contain')
  })
})

describe('visibleRowPaths', () => {
  it('lists visible rows in display order, honoring the collapsed map', () => {
    // img is collapsed -> its child logo.svg is excluded.
    expect(visibleRowPaths(tree, { '/ws/img': true })).toEqual([
      '/ws/docs',
      '/ws/docs/note.md',
      '/ws/img',
      '/ws/readme.md',
    ])
  })

  it('includes a collapsed subtree once expanded', () => {
    expect(visibleRowPaths(tree, {})).toContain('/ws/img/logo.svg')
  })

  it('returns [] for a null tree', () => {
    expect(visibleRowPaths(null, {})).toEqual([])
  })
})

describe('folderPaths', () => {
  it('collects every directory path including the root', () => {
    expect(folderPaths(tree)).toEqual(new Set(['/ws', '/ws/docs', '/ws/img']))
  })
})

describe('folderRows', () => {
  it('lists the root then every folder with indentation depth', () => {
    expect(folderRows(tree)).toEqual([
      { path: '/ws', label: 'ws', depth: 0 },
      { path: '/ws/docs', label: 'docs', depth: 1 },
      { path: '/ws/img', label: 'img', depth: 1 },
    ])
  })

  it('returns [] for a null tree', () => {
    expect(folderRows(null)).toEqual([])
  })
})

describe('firstMarkdownPath', () => {
  it('walks depth-first in render order: dirs before files, so the first md inside the first folder wins', () => {
    // The fixture tree renders docs/ (note.md) before the root readme.md.
    expect(firstMarkdownPath(tree)).toBe('/ws/docs/note.md')
  })

  it('skips non-markdown files, descending until a markdown file is found', () => {
    const t = dir(
      'ws',
      '/ws',
      [
        dir('img', '/ws/img', [], [file('logo.svg', '/ws/img/logo.svg')]),
        dir('docs', '/ws/docs', [dir('deep', '/ws/docs/deep', [], [file('Guide.MARKDOWN', '/ws/docs/deep/Guide.MARKDOWN')])], []),
      ],
      [file('notes.md', '/ws/notes.md')],
    )
    // img/ has no markdown; docs/deep's case-insensitive .MARKDOWN still
    // precedes the root-level notes.md in render order.
    expect(firstMarkdownPath(t)).toBe('/ws/docs/deep/Guide.MARKDOWN')
  })

  it('falls back to a root-level file when no folder holds any markdown', () => {
    const t = dir('ws', '/ws', [dir('img', '/ws/img')], [
      file('readme.txt', '/ws/readme.txt'),
      file('a.md', '/ws/a.md'),
    ])
    expect(firstMarkdownPath(t)).toBe('/ws/a.md')
  })

  it('returns null for a null tree and for a tree with no markdown files', () => {
    expect(firstMarkdownPath(null)).toBeNull()
    expect(
      firstMarkdownPath(dir('ws', '/ws', [dir('img', '/ws/img')], [file('a.txt', '/ws/a.txt')])),
    ).toBeNull()
  })
})

describe('pasteTargetDir', () => {
  const folders = new Set(['/ws', '/ws/docs', '/ws/img'])

  it('uses the focused folder directly', () => {
    expect(pasteTargetDir('/ws/docs', folders, '/ws')).toBe('/ws/docs')
  })
  it("uses a focused file's parent", () => {
    expect(pasteTargetDir('/ws/docs/note.md', folders, '/ws')).toBe('/ws/docs')
  })
  it('falls back to the workspace root when nothing is focused', () => {
    expect(pasteTargetDir(null, folders, '/ws')).toBe('/ws')
  })
})
