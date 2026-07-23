import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import {
  addOpen,
  removeOpen,
  neighbourAfterClose,
  neighbourInStrip,
  retargetOpen,
  removeOpenSubtree,
  retargetPreview,
  clearPreviewInSubtree,
  openList,
  previewPath,
  pinOpen,
  pinPreview,
} from './openList'

describe('addOpen', () => {
  it('appends a new path to an empty list', () => {
    expect(addOpen([], '/a.md')).toEqual(['/a.md'])
  })

  it('appends a new path to the end, keeping existing order', () => {
    expect(addOpen(['/a.md', '/b.md'], '/c.md')).toEqual(['/a.md', '/b.md', '/c.md'])
  })

  it('dedups: re-adding an already-open path is a no-op (keeps first position)', () => {
    expect(addOpen(['/a.md', '/b.md', '/c.md'], '/b.md')).toEqual(['/a.md', '/b.md', '/c.md'])
  })

  it('returns a new array reference even on a no-op dedup miss vs hit (referential purity)', () => {
    const list = ['/a.md']
    expect(addOpen(list, '/a.md')).toBe(list) // no-op dedup: same reference is fine (append-if-absent)
    expect(addOpen(list, '/b.md')).not.toBe(list)
  })
})

describe('removeOpen', () => {
  it('removes the matching path', () => {
    expect(removeOpen(['/a.md', '/b.md', '/c.md'], '/b.md')).toEqual(['/a.md', '/c.md'])
  })

  it('is a no-op when the path is absent', () => {
    expect(removeOpen(['/a.md'], '/z.md')).toEqual(['/a.md'])
  })

  it('empties a single-entry list', () => {
    expect(removeOpen(['/a.md'], '/a.md')).toEqual([])
  })
})

describe('neighbourAfterClose', () => {
  it('closing a non-active (background) entry leaves the active path unchanged', () => {
    expect(neighbourAfterClose(['/a.md', '/b.md', '/c.md'], '/a.md', '/b.md')).toBe('/b.md')
  })

  it('active-in-middle: switches to the previous entry', () => {
    expect(neighbourAfterClose(['/a.md', '/b.md', '/c.md'], '/b.md', '/b.md')).toBe('/a.md')
  })

  it('active-at-end: switches to the previous entry', () => {
    expect(neighbourAfterClose(['/a.md', '/b.md', '/c.md'], '/c.md', '/c.md')).toBe('/b.md')
  })

  it('active-at-start: switches to the (new) next entry', () => {
    expect(neighbourAfterClose(['/a.md', '/b.md', '/c.md'], '/a.md', '/a.md')).toBe('/b.md')
  })

  it('single-entry list: closing the only (active) entry yields null (caller falls back to newDoc)', () => {
    expect(neighbourAfterClose(['/a.md'], '/a.md', '/a.md')).toBeNull()
  })

  it('closing set has no active path (already untitled): returns null unchanged', () => {
    expect(neighbourAfterClose(['/a.md', '/b.md'], '/a.md', null)).toBeNull()
  })

  it('an active PREVIEW appended after the pinned list falls back to the last pinned entry', () => {
    // The preview path never lives in openList but renders as the LAST row;
    // App.svelte appends it before the lookup so closing it activates the
    // last pinned entry instead of blanking to a new doc.
    expect(neighbourAfterClose(['/a.md', '/b.md', '/peek.md'], '/peek.md', '/peek.md')).toBe(
      '/b.md',
    )
  })

  it('an active preview appended to an EMPTY pinned list still yields null (nothing to fall back to)', () => {
    expect(neighbourAfterClose(['/peek.md'], '/peek.md', '/peek.md')).toBeNull()
  })
})

describe('retargetOpen', () => {
  it('rewrites an exact file match', () => {
    expect(retargetOpen(['/a.md', '/b.md'], '/a.md', '/renamed.md')).toEqual([
      '/renamed.md',
      '/b.md',
    ])
  })

  it('preserves position when rewriting', () => {
    expect(retargetOpen(['/a.md', '/b.md', '/c.md'], '/b.md', '/z.md')).toEqual([
      '/a.md',
      '/z.md',
      '/c.md',
    ])
  })

  it('rewrites every entry nested under a moved ancestor folder, segment-safely', () => {
    expect(
      retargetOpen(
        ['/ws/docs/a.md', '/ws/docs/sub/b.md', '/ws/docs2/c.md', '/ws/other.md'],
        '/ws/docs',
        '/ws/renamed',
      ),
    ).toEqual(['/ws/renamed/a.md', '/ws/renamed/sub/b.md', '/ws/docs2/c.md', '/ws/other.md'])
  })

  it('dedups when a rewrite lands on a path already open, keeping the first position', () => {
    expect(retargetOpen(['/a.md', '/b.md'], '/a.md', '/b.md')).toEqual(['/b.md'])
  })

  it('is a referential no-op when nothing in the list is affected', () => {
    const list = ['/a.md', '/b.md']
    expect(retargetOpen(list, '/z.md', '/y.md')).toBe(list)
  })
})

describe('removeOpenSubtree', () => {
  it('removes the exact path', () => {
    expect(removeOpenSubtree(['/a.md', '/b.md'], '/a.md')).toEqual(['/b.md'])
  })

  it('removes every entry nested under a trashed folder, segment-safely', () => {
    expect(
      removeOpenSubtree(
        ['/ws/docs/a.md', '/ws/docs/sub/b.md', '/ws/docs2/c.md', '/ws/other.md'],
        '/ws/docs',
      ),
    ).toEqual(['/ws/docs2/c.md', '/ws/other.md'])
  })

  it('is a referential no-op when nothing in the list is affected', () => {
    const list = ['/a.md', '/b.md']
    expect(removeOpenSubtree(list, '/z.md')).toBe(list)
  })
})

describe('retargetPreview', () => {
  it('passes null through (no preview open)', () => {
    expect(retargetPreview(null, '/a.md', '/b.md')).toBeNull()
  })

  it('rewrites an exact file match', () => {
    expect(retargetPreview('/a.md', '/a.md', '/renamed.md')).toBe('/renamed.md')
  })

  it('follows a moved ancestor folder, segment-safely', () => {
    expect(retargetPreview('/ws/docs/a.md', '/ws/docs', '/ws/renamed')).toBe('/ws/renamed/a.md')
    expect(retargetPreview('/ws/docs2/a.md', '/ws/docs', '/ws/renamed')).toBe('/ws/docs2/a.md')
  })

  it('leaves an unaffected preview unchanged', () => {
    expect(retargetPreview('/keep.md', '/z.md', '/y.md')).toBe('/keep.md')
  })
})

describe('clearPreviewInSubtree', () => {
  it('passes null through', () => {
    expect(clearPreviewInSubtree(null, '/a.md')).toBeNull()
  })

  it('clears an exact match', () => {
    expect(clearPreviewInSubtree('/a.md', '/a.md')).toBeNull()
  })

  it('clears a preview nested under a trashed folder, segment-safely', () => {
    expect(clearPreviewInSubtree('/ws/docs/a.md', '/ws/docs')).toBeNull()
    expect(clearPreviewInSubtree('/ws/docs2/a.md', '/ws/docs')).toBe('/ws/docs2/a.md')
  })

  it('leaves an unrelated preview untouched', () => {
    expect(clearPreviewInSubtree('/keep.md', '/z.md')).toBe('/keep.md')
  })
})

describe('pinOpen / pinPreview (store transitions)', () => {
  beforeEach(() => {
    openList.set([])
    previewPath.set(null)
  })

  it('pinOpen appends to openList and vacates a matching preview', () => {
    previewPath.set('/a.md')
    pinOpen('/a.md')
    expect(get(openList)).toEqual(['/a.md'])
    expect(get(previewPath)).toBeNull()
  })

  it('pinOpen leaves a NON-matching preview alone (plain open next to a preview)', () => {
    previewPath.set('/peek.md')
    pinOpen('/other.md')
    expect(get(openList)).toEqual(['/other.md'])
    expect(get(previewPath)).toBe('/peek.md')
  })

  it('pinOpen dedups an already-pinned path', () => {
    openList.set(['/a.md', '/b.md'])
    pinOpen('/a.md')
    expect(get(openList)).toEqual(['/a.md', '/b.md'])
  })

  it('pinPreview promotes the current preview to the end of the pinned list', () => {
    openList.set(['/a.md'])
    previewPath.set('/peek.md')
    pinPreview()
    expect(get(openList)).toEqual(['/a.md', '/peek.md'])
    expect(get(previewPath)).toBeNull()
  })

  it('pinPreview is a no-op when nothing is previewed', () => {
    openList.set(['/a.md'])
    pinPreview()
    expect(get(openList)).toEqual(['/a.md'])
    expect(get(previewPath)).toBeNull()
  })
})

describe('neighbourInStrip', () => {
  const open = ['/a.md', '/b.md', '/c.md']

  it('steps forward through the pinned rows', () => {
    expect(neighbourInStrip('/a.md', open, null, 1)).toBe('/b.md')
    expect(neighbourInStrip('/b.md', open, null, 1)).toBe('/c.md')
  })

  it('steps backward through the pinned rows', () => {
    expect(neighbourInStrip('/c.md', open, null, -1)).toBe('/b.md')
    expect(neighbourInStrip('/b.md', open, null, -1)).toBe('/a.md')
  })

  it('wraps forward off the last row and backward off the first', () => {
    expect(neighbourInStrip('/c.md', open, null, 1)).toBe('/a.md')
    expect(neighbourInStrip('/a.md', open, null, -1)).toBe('/c.md')
  })

  it('includes the preview row, appended after every pinned row', () => {
    expect(neighbourInStrip('/c.md', open, '/peek.md', 1)).toBe('/peek.md')
    expect(neighbourInStrip('/peek.md', open, '/peek.md', 1)).toBe('/a.md') // wrap off the preview
    expect(neighbourInStrip('/peek.md', open, '/peek.md', -1)).toBe('/c.md')
    expect(neighbourInStrip('/a.md', open, '/peek.md', -1)).toBe('/peek.md') // backward wrap lands on it
  })

  it('ignores a preview that is also pinned (the strip hides that row)', () => {
    expect(neighbourInStrip('/c.md', open, '/a.md', 1)).toBe('/a.md') // plain wrap, no duplicate row
    expect(neighbourInStrip('/a.md', open, '/a.md', -1)).toBe('/c.md')
  })

  it('enters the cycle from the untitled scratch (no row): next=first, previous=last', () => {
    expect(neighbourInStrip(null, open, null, 1)).toBe('/a.md')
    expect(neighbourInStrip(null, open, null, -1)).toBe('/c.md')
    expect(neighbourInStrip(null, open, '/peek.md', -1)).toBe('/peek.md')
  })

  it('reaches even a single row from the untitled scratch', () => {
    expect(neighbourInStrip(null, ['/a.md'], null, 1)).toBe('/a.md')
    expect(neighbourInStrip(null, [], '/peek.md', -1)).toBe('/peek.md')
  })

  it('is null on a single row that is already active (nowhere to go)', () => {
    expect(neighbourInStrip('/a.md', ['/a.md'], null, 1)).toBeNull()
    expect(neighbourInStrip('/a.md', ['/a.md'], null, -1)).toBeNull()
    expect(neighbourInStrip('/peek.md', [], '/peek.md', 1)).toBeNull()
  })

  it('is null on an empty strip', () => {
    expect(neighbourInStrip(null, [], null, 1)).toBeNull()
    expect(neighbourInStrip('/a.md', [], null, -1)).toBeNull()
  })
})
