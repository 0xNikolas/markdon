import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { doc, openDoc, newDoc, edit, markSaved } from './doc'

describe('document store', () => {
  beforeEach(() => newDoc()) // reset (also bumps loadId, fine for isolation)

  it('openDoc sets path and content, clears dirty, bumps loadId', () => {
    const before = get(doc).loadId
    openDoc('/tmp/a.md', '# A')
    const s = get(doc)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# A')
    expect(s.dirty).toBe(false)
    expect(s.loadId).toBe(before + 1)
  })

  it('edit updates content, sets dirty, leaves loadId unchanged', () => {
    openDoc('/tmp/a.md', '# A')
    const loadId = get(doc).loadId
    edit('# A edited')
    const s = get(doc)
    expect(s.content).toBe('# A edited')
    expect(s.dirty).toBe(true)
    expect(s.loadId).toBe(loadId)
  })

  it('markSaved clears dirty and sets path without bumping loadId', () => {
    newDoc()
    edit('draft')
    const loadId = get(doc).loadId
    markSaved('/tmp/new.md')
    const s = get(doc)
    expect(s.path).toBe('/tmp/new.md')
    expect(s.dirty).toBe(false)
    expect(s.loadId).toBe(loadId)
  })

  it('newDoc resets to an empty untitled document and bumps loadId', () => {
    openDoc('/tmp/a.md', '# A')
    const before = get(doc).loadId
    newDoc()
    const s = get(doc)
    expect(s.path).toBeNull()
    expect(s.content).toBe('')
    expect(s.dirty).toBe(false)
    expect(s.loadId).toBe(before + 1)
  })
})
