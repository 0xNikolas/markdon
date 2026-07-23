import { describe, it, expect } from 'vitest'
import {
  leafNameError,
  visibleRowPaths,
  folderPaths,
  folderRows,
  pasteTargetDir,
} from './fileTree'
import { tree } from './test-support/workspaceFixtures'

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
