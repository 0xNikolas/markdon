import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { doc, openDoc, newDoc, edit, markSaved, isDirty } from './doc'

describe('doc store', () => {
  beforeEach(() => newDoc()) // reset (also bumps loadId, fine for isolation)

  it('openDoc sets path and content, is clean, bumps loadId', () => {
    const before = get(doc).loadId
    openDoc('/tmp/a.md', '# A')
    const s = get(doc)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# A')
    expect(s.savedContent).toBe('# A')
    expect(isDirty(s)).toBe(false)
    expect(s.loadId).toBe(before + 1)
  })

  it('edit updates content, becomes dirty, leaves loadId unchanged', () => {
    openDoc('/tmp/a.md', '# A')
    const loadId = get(doc).loadId
    edit('# A edited')
    const s = get(doc)
    expect(s.content).toBe('# A edited')
    expect(isDirty(s)).toBe(true)
    expect(s.loadId).toBe(loadId)
  })

  it('markSaved records what was written and sets path without bumping loadId', () => {
    newDoc()
    edit('draft')
    const loadId = get(doc).loadId
    markSaved('/tmp/new.md', 'draft')
    const s = get(doc)
    expect(s.path).toBe('/tmp/new.md')
    expect(s.savedContent).toBe('draft')
    expect(isDirty(s)).toBe(false)
    expect(s.loadId).toBe(loadId)
  })

  it('edits made during an in-flight save stay dirty after markSaved', () => {
    newDoc()
    edit('v1')
    // save() snapshots 'v1' and starts writing; the user types 'v2' meanwhile
    edit('v2')
    markSaved('/tmp/a.md', 'v1') // the write that finished contained 'v1'
    const s = get(doc)
    expect(s.content).toBe('v2')
    expect(s.savedContent).toBe('v1')
    expect(isDirty(s)).toBe(true) // 'v2' is NOT on disk — must remain dirty
  })

  it('newDoc resets to an empty untitled document and bumps loadId', () => {
    openDoc('/tmp/a.md', '# A')
    const before = get(doc).loadId
    newDoc()
    const s = get(doc)
    expect(s.path).toBeNull()
    expect(s.content).toBe('')
    expect(isDirty(s)).toBe(false)
    expect(s.loadId).toBe(before + 1)
  })
})
