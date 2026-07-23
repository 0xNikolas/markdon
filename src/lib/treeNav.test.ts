import { describe, it, expect } from 'vitest'
import { treeKeyIntent, type TreeKeyIntent } from './treeNav'

/**
 * Row universe mirroring the e2e fixture shape:
 *   /ws/docs/       note.md
 *   /ws/img/        logo.svg     (collapsible)
 *   /ws/empty/      (no children)
 *   /ws/readme.md
 */
const FOLDERS = new Set(['/ws', '/ws/docs', '/ws/img', '/ws/empty'])

/** All folders expanded. */
const ALL = [
  '/ws/docs',
  '/ws/docs/note.md',
  '/ws/img',
  '/ws/img/logo.svg',
  '/ws/empty',
  '/ws/readme.md',
]

/** img collapsed — logo.svg hidden. */
const IMG_COLLAPSED = ['/ws/docs', '/ws/docs/note.md', '/ws/img', '/ws/empty', '/ws/readme.md']

function intent(
  key: string,
  focused: string | null,
  visible: readonly string[] = ALL,
  collapsed: Record<string, boolean> = {},
): TreeKeyIntent {
  return treeKeyIntent(key, focused, visible, FOLDERS, collapsed)
}

describe('treeKeyIntent — ArrowDown / ArrowUp', () => {
  it('moves to the next / previous visible row', () => {
    expect(intent('ArrowDown', '/ws/docs')).toEqual({ kind: 'focus', path: '/ws/docs/note.md' })
    expect(intent('ArrowUp', '/ws/img')).toEqual({ kind: 'focus', path: '/ws/docs/note.md' })
  })

  it('clamps at the ends (no wrap)', () => {
    expect(intent('ArrowDown', '/ws/readme.md')).toBeNull()
    expect(intent('ArrowUp', '/ws/docs')).toBeNull()
  })

  it('lands on the first / last row when nothing is focused', () => {
    expect(intent('ArrowDown', null)).toEqual({ kind: 'focus', path: '/ws/docs' })
    expect(intent('ArrowUp', null)).toEqual({ kind: 'focus', path: '/ws/readme.md' })
  })

  it('treats a focused path that is not visible (collapsed away) as no focus', () => {
    expect(intent('ArrowDown', '/ws/img/logo.svg', IMG_COLLAPSED, { '/ws/img': true })).toEqual({
      kind: 'focus',
      path: '/ws/docs',
    })
  })

  it('skips rows hidden by a collapsed folder', () => {
    expect(intent('ArrowDown', '/ws/img', IMG_COLLAPSED, { '/ws/img': true })).toEqual({
      kind: 'focus',
      path: '/ws/empty',
    })
  })
})

describe('treeKeyIntent — ArrowRight', () => {
  it('expands a collapsed folder', () => {
    expect(intent('ArrowRight', '/ws/img', IMG_COLLAPSED, { '/ws/img': true })).toEqual({
      kind: 'expand',
      path: '/ws/img',
    })
  })

  it('steps into the first child of an expanded folder', () => {
    expect(intent('ArrowRight', '/ws/docs')).toEqual({ kind: 'focus', path: '/ws/docs/note.md' })
  })

  it('does nothing on an expanded folder with no children (next row is a sibling)', () => {
    expect(intent('ArrowRight', '/ws/empty')).toBeNull()
  })

  it('does nothing on a file or with no focus', () => {
    expect(intent('ArrowRight', '/ws/readme.md')).toBeNull()
    expect(intent('ArrowRight', null)).toBeNull()
  })
})

describe('treeKeyIntent — ArrowLeft', () => {
  it('collapses an expanded folder', () => {
    expect(intent('ArrowLeft', '/ws/img')).toEqual({ kind: 'collapse', path: '/ws/img' })
  })

  it('steps out to the parent folder from a child row', () => {
    expect(intent('ArrowLeft', '/ws/docs/note.md')).toEqual({ kind: 'focus', path: '/ws/docs' })
  })

  it('steps out to the parent from a collapsed nested folder', () => {
    const visible = ['/ws/a', '/ws/a/b', '/ws/readme.md']
    const folders = new Set(['/ws', '/ws/a', '/ws/a/b'])
    expect(treeKeyIntent('ArrowLeft', '/ws/a/b', visible, folders, { '/ws/a/b': true })).toEqual({
      kind: 'focus',
      path: '/ws/a',
    })
  })

  it('does nothing on a root-level file (the workspace root is not a row)', () => {
    expect(intent('ArrowLeft', '/ws/readme.md')).toBeNull()
    expect(intent('ArrowLeft', null)).toBeNull()
  })
})

describe('treeKeyIntent — Home / End', () => {
  it('jumps to the first / last visible row', () => {
    expect(intent('Home', '/ws/readme.md')).toEqual({ kind: 'focus', path: '/ws/docs' })
    expect(intent('End', '/ws/docs')).toEqual({ kind: 'focus', path: '/ws/readme.md' })
    expect(intent('Home', null)).toEqual({ kind: 'focus', path: '/ws/docs' })
    expect(intent('End', null)).toEqual({ kind: 'focus', path: '/ws/readme.md' })
  })

  it('is a no-op when already there', () => {
    expect(intent('Home', '/ws/docs')).toBeNull()
    expect(intent('End', '/ws/readme.md')).toBeNull()
  })
})

describe('treeKeyIntent — everything else', () => {
  it.each(['Enter', ' ', 'Tab', 'Escape', 'a', 'PageDown'])('ignores %j', (key) => {
    expect(intent(key, '/ws/docs')).toBeNull()
  })

  it('does nothing in an empty tree', () => {
    expect(treeKeyIntent('ArrowDown', null, [], new Set(), {})).toBeNull()
    expect(treeKeyIntent('Home', null, [], new Set(), {})).toBeNull()
  })
})
