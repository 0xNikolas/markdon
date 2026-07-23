import { describe, it, expect } from 'vitest'
import type { WorkspaceDir } from './workspace'
import { flattenMarkdownFiles, fuzzyRank, QUICK_OPEN_CAP, type QuickOpenItem } from './quickOpen'

// -- fixtures -----------------------------------------------------------------

const file = (dir: string, name: string) => ({ name, path: `/ws/${dir ? `${dir}/` : ''}${name}` })

const TREE: WorkspaceDir = {
  name: 'ws',
  path: '/ws',
  truncated: false,
  dirs: [
    {
      name: 'docs',
      path: '/ws/docs',
      truncated: false,
      dirs: [
        {
          name: 'guides',
          path: '/ws/docs/guides',
          truncated: false,
          dirs: [],
          files: [file('docs/guides', 'setup.md')],
        },
      ],
      files: [file('docs', 'intro.md'), file('docs', 'diagram.png')],
    },
  ],
  files: [file('', 'notes.md'), file('', 'readme.txt'), file('', 'todo.MARKDOWN')],
}

const item = (dir: string, name: string): QuickOpenItem => ({ ...file(dir, name), dir })

describe('flattenMarkdownFiles', () => {
  it('is empty for a null tree (no workspace)', () => {
    expect(flattenMarkdownFiles(null)).toEqual([])
  })

  it('lists only markdown files (case-insensitive extension), never .png/.txt', () => {
    const names = flattenMarkdownFiles(TREE).map((i) => i.name)
    expect(names).toEqual(['setup.md', 'intro.md', 'notes.md', 'todo.MARKDOWN'])
  })

  it('walks in sidebar display order: subdirectories first, depth-first, then files', () => {
    expect(flattenMarkdownFiles(TREE).map((i) => i.path)).toEqual([
      '/ws/docs/guides/setup.md',
      '/ws/docs/intro.md',
      '/ws/notes.md',
      '/ws/todo.MARKDOWN',
    ])
  })

  it('computes workspace-relative dirs, empty for root-level files', () => {
    expect(flattenMarkdownFiles(TREE)).toEqual([
      item('docs/guides', 'setup.md'),
      item('docs', 'intro.md'),
      item('', 'notes.md'),
      item('', 'todo.MARKDOWN'),
    ])
  })
})

describe('fuzzyRank: empty query', () => {
  const items = [item('', 'a.md'), item('', 'b.md'), item('', 'c.md')]

  it('returns the tree order untouched with no active file', () => {
    expect(fuzzyRank('', items, null)).toEqual(items)
  })

  it('moves the active file LAST (VS Code parity: least likely jump target)', () => {
    expect(fuzzyRank('', items, '/ws/a.md').map((i) => i.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })

  it('leaves the order alone for an active path not in the list', () => {
    expect(fuzzyRank('', items, '/elsewhere/x.md')).toEqual(items)
  })

  it(`caps the listing at ${QUICK_OPEN_CAP}`, () => {
    const many = Array.from({ length: QUICK_OPEN_CAP + 10 }, (_, i) => item('', `f${i}.md`))
    expect(fuzzyRank('', many, null)).toHaveLength(QUICK_OPEN_CAP)
    expect(fuzzyRank('', many, null)[0].name).toBe('f0.md')
  })
})

describe('fuzzyRank: matching', () => {
  it('drops items where the query is not a subsequence of the display path', () => {
    const items = [item('', 'notes.md'), item('', 'ideas.md')]
    expect(fuzzyRank('zzz', items).map((i) => i.name)).toEqual([])
    expect(fuzzyRank('ntsmd', items).map((i) => i.name)).toEqual(['notes.md'])
  })

  it('matches case-insensitively in both directions', () => {
    const items = [item('', 'NOTES.md'), item('sub', 'ideas.md')]
    expect(fuzzyRank('notes', items).map((i) => i.name)).toEqual(['NOTES.md'])
    expect(fuzzyRank('IDEAS', items).map((i) => i.name)).toEqual(['ideas.md'])
  })

  it('matches against the workspace-relative path, so "/" queries span segments', () => {
    const items = [item('sub', 'nested.md'), item('', 'sub-nested.md')]
    expect(fuzzyRank('sub/ne', items).map((i) => i.path)).toEqual(['/ws/sub/nested.md'])
  })

  it('caps ranked results too', () => {
    const many = Array.from({ length: QUICK_OPEN_CAP + 10 }, (_, i) => item('', `note${i}.md`))
    expect(fuzzyRank('note', many)).toHaveLength(QUICK_OPEN_CAP)
  })
})

describe('fuzzyRank: ranking', () => {
  it('a basename match beats a dir-only match, regardless of raw score', () => {
    // "docs" scores heavily in the dir item's path (segment start + a full
    // consecutive run) yet the name-tier item must still win.
    const items = [item('docs', 'x.md'), item('', 'document-list.md')]
    expect(fuzzyRank('docs', items).map((i) => i.name)).toEqual(['document-list.md', 'x.md'])
  })

  it('consecutive runs beat the same letters scattered', () => {
    // Both are name matches of equal display length; only adjacency differs.
    const items = [item('', 'n-o-t-e.md'), item('', 'note-x-y.md')]
    expect(fuzzyRank('note', items).map((i) => i.name)).toEqual(['note-x-y.md', 'n-o-t-e.md'])
  })

  it('segment starts score higher than mid-word hits', () => {
    // 'n' at the start of the basename segment vs buried inside it.
    const items = [item('', 'xn.md'), item('', 'nx.md')]
    expect(fuzzyRank('n', items).map((i) => i.name)).toEqual(['nx.md', 'xn.md'])
  })

  it('word starts (after -, _, ., space) score higher than mid-word hits', () => {
    const items = [item('', 'axo.md'), item('', 'a-xo.md')]
    expect(fuzzyRank('x', items).map((i) => i.name)).toEqual(['a-xo.md', 'axo.md'])
  })

  it('breaks score ties toward the shorter display path', () => {
    // Identical prefix match, one path just longer.
    const items = [item('deep/nested', 'a.md'), item('', 'a.md')]
    expect(fuzzyRank('a.md', items).map((i) => i.path)).toEqual([
      '/ws/a.md',
      '/ws/deep/nested/a.md',
    ])
  })

  it('breaks remaining ties by tree order (stable)', () => {
    const items = [item('', 'ab.md'), item('', 'ba.md')]
    // Same length; 'a' hits a segment start in ab.md but a mid-word char in
    // ba.md, so craft a true tie instead: query matches both at index 0.
    expect(fuzzyRank('b', [item('', 'b1.md'), item('', 'b2.md')]).map((i) => i.name)).toEqual([
      'b1.md',
      'b2.md',
    ])
    // And a genuinely different-score pair stays score-ordered.
    expect(fuzzyRank('a', items).map((i) => i.name)).toEqual(['ab.md', 'ba.md'])
  })

  it('the active file is NOT special-cased once a query is typed', () => {
    const items = [item('', 'notes.md'), item('', 'notes-old.md')]
    expect(fuzzyRank('notes', items, '/ws/notes.md').map((i) => i.name)).toEqual([
      'notes.md',
      'notes-old.md',
    ])
  })
})
