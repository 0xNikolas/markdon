import { describe, it, expect, beforeEach } from 'vitest'
import { touchRecency, recencyOf, resetRecency } from './recency'

describe('recency', () => {
  beforeEach(() => {
    resetRecency()
  })

  it('reports 0 for a path never loaded this session', () => {
    expect(recencyOf('/ws/never.md')).toBe(0)
  })

  it('every touch is strictly greater than 0 and than all earlier touches', () => {
    touchRecency('/ws/a.md')
    touchRecency('/ws/b.md')
    expect(recencyOf('/ws/a.md')).toBeGreaterThan(0)
    expect(recencyOf('/ws/b.md')).toBeGreaterThan(recencyOf('/ws/a.md'))
  })

  it('re-touching a path moves it ahead of everything touched since', () => {
    touchRecency('/ws/a.md')
    touchRecency('/ws/b.md')
    touchRecency('/ws/a.md')
    expect(recencyOf('/ws/a.md')).toBeGreaterThan(recencyOf('/ws/b.md'))
  })

  it('reset forgets all paths and restarts the sequence', () => {
    touchRecency('/ws/a.md')
    resetRecency()
    expect(recencyOf('/ws/a.md')).toBe(0)
    touchRecency('/ws/b.md')
    expect(recencyOf('/ws/b.md')).toBe(1)
  })
})
