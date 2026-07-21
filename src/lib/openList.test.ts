import { describe, it, expect } from 'vitest'
import { addOpen, removeOpen, neighbourAfterClose } from './openList'

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
})
