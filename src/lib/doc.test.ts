import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import {
  doc,
  openDoc,
  newDoc,
  edit,
  markSaved,
  isDirty,
  enableEditing,
  retargetPath,
  detachToUntitled,
  revertBuffer,
} from './doc'

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

  it('openDoc defaults to editable and accepts a readonly flag', () => {
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
    openDoc('/tmp/b.md', '# B', true)
    expect(get(doc).readonly).toBe(true)
  })

  it('edit is ignored while readonly, so the buffer stays clean', () => {
    openDoc('/tmp/a.md', '# A', true)
    edit('# A edited')
    const s = get(doc)
    expect(s.content).toBe('# A')
    expect(isDirty(s)).toBe(false)
  })

  it('enableEditing lifts readonly and edit works afterwards', () => {
    openDoc('/tmp/a.md', '# A', true)
    enableEditing()
    expect(get(doc).readonly).toBe(false)
    edit('# A edited')
    expect(get(doc).content).toBe('# A edited')
    expect(isDirty(get(doc))).toBe(true)
  })

  it('newDoc resets readonly', () => {
    openDoc('/tmp/a.md', '# A', true)
    newDoc()
    expect(get(doc).readonly).toBe(false)
  })
})

describe('retargetPath', () => {
  beforeEach(() => newDoc())

  it('rewrites the path when the open file itself is renamed, keeping dirty state', () => {
    openDoc('/ws/old.md', '# A')
    edit('# A edited') // dirty
    const loadId = get(doc).loadId
    retargetPath('/ws/old.md', '/ws/new.md')
    const s = get(doc)
    expect(s.path).toBe('/ws/new.md')
    expect(s.content).toBe('# A edited')
    expect(isDirty(s)).toBe(true)
    expect(s.loadId).toBe(loadId) // no remount
  })

  it('rewrites the path when an ancestor folder is moved', () => {
    openDoc('/ws/docs/note.md', '# A')
    retargetPath('/ws/docs', '/ws/archive/docs')
    expect(get(doc).path).toBe('/ws/archive/docs/note.md')
  })

  it('is segment-safe: a sibling folder with a shared string prefix is untouched', () => {
    openDoc('/ws/proj2/note.md', '# A')
    retargetPath('/ws/proj', '/ws/renamed')
    expect(get(doc).path).toBe('/ws/proj2/note.md')
  })

  it('leaves an unrelated open doc untouched', () => {
    openDoc('/ws/other.md', '# A')
    retargetPath('/ws/old.md', '/ws/new.md')
    expect(get(doc).path).toBe('/ws/other.md')
  })

  it('is a no-op when nothing is open', () => {
    newDoc()
    retargetPath('/ws/old.md', '/ws/new.md')
    expect(get(doc).path).toBeNull()
  })
})

describe('revertBuffer', () => {
  beforeEach(() => newDoc())

  it('loads content as unsaved changes, preserving savedContent and path, bumping loadId', () => {
    openDoc('/ws/a.md', '# current')
    const loadId = get(doc).loadId
    revertBuffer('# old version')
    const s = get(doc)
    expect(s.content).toBe('# old version')
    expect(s.savedContent).toBe('# current') // disk truth untouched
    expect(s.path).toBe('/ws/a.md') // still the same file
    expect(isDirty(s)).toBe(true) // buffer now differs from disk
    expect(s.loadId).toBe(loadId + 1) // editor remounts with the reverted text
  })

  it('always makes the buffer editable, even reverting a read-only doc', () => {
    openDoc('/ws/a.md', '# current', true)
    revertBuffer('# old version')
    const s = get(doc)
    expect(s.readonly).toBe(false)
    expect(s.content).toBe('# old version')
  })
})

describe('detachToUntitled', () => {
  beforeEach(() => newDoc())

  it('keeps the buffer, drops the path, and marks the doc dirty', () => {
    openDoc('/ws/gone.md', '# content')
    const loadId = get(doc).loadId
    detachToUntitled()
    const s = get(doc)
    expect(s.path).toBeNull()
    expect(s.content).toBe('# content') // nothing lost
    expect(s.savedContent).toBe('')
    expect(isDirty(s)).toBe(true)
    expect(s.loadId).toBe(loadId) // buffer preserved, no remount
  })
})
