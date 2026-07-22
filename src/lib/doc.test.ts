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
  enterReadonly,
  retargetPath,
  detachIfAffected,
  revertBuffer,
  resetReadonlyMemory,
  adoptNormalization,
} from './doc'

describe('doc store', () => {
  beforeEach(() => {
    newDoc() // reset (also bumps loadId, fine for isolation)
    resetReadonlyMemory()
  })

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

  it('enterReadonly sets the flag on a clean buffer', () => {
    openDoc('/tmp/a.md', '# A')
    enterReadonly()
    const s = get(doc)
    expect(s.readonly).toBe(true)
    expect(s.content).toBe('# A')
    expect(isDirty(s)).toBe(false)
  })

  it('enterReadonly no-ops on a dirty buffer, preserving the readonly⇒clean invariant', () => {
    openDoc('/tmp/a.md', '# A')
    edit('# A edited') // dirty
    enterReadonly()
    const s = get(doc)
    expect(s.readonly).toBe(false) // refused: would strand unsaved edits behind readonly
    expect(isDirty(s)).toBe(true)
  })

  it('enterReadonly then enableEditing round-trips, preserving content and savedContent', () => {
    openDoc('/tmp/a.md', '# A')
    enterReadonly()
    enableEditing()
    const s = get(doc)
    expect(s.readonly).toBe(false)
    expect(s.content).toBe('# A')
    expect(s.savedContent).toBe('# A')
    expect(isDirty(s)).toBe(false)
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

describe('detachIfAffected', () => {
  beforeEach(() => newDoc())

  it('detaches when the open file is exactly a deleted path: keeps the buffer, drops the path, marks dirty', () => {
    openDoc('/ws/gone.md', '# content')
    const loadId = get(doc).loadId
    expect(detachIfAffected(['/ws/gone.md'])).toBe(true)
    const s = get(doc)
    expect(s.path).toBeNull()
    expect(s.content).toBe('# content') // nothing lost
    expect(s.savedContent).toBe('')
    expect(isDirty(s)).toBe(true)
    expect(s.loadId).toBe(loadId) // buffer preserved, no remount
  })

  it('detaches when the open file is a descendant of a deleted folder', () => {
    openDoc('/ws/docs/note.md', '# note')
    expect(detachIfAffected(['/ws/docs'])).toBe(true)
    expect(get(doc).path).toBeNull()
  })

  it('does not detach — nor touch — an unaffected open doc', () => {
    openDoc('/ws/keep.md', '# keep')
    expect(detachIfAffected(['/ws/other.md'])).toBe(false)
    const s = get(doc)
    expect(s.path).toBe('/ws/keep.md')
    expect(s.savedContent).toBe('# keep')
    expect(isDirty(s)).toBe(false)
  })

  it('is a no-op when nothing is open (path null)', () => {
    newDoc()
    expect(detachIfAffected(['/ws/anything.md'])).toBe(false)
    expect(get(doc).path).toBeNull()
  })
})

describe('readonly memory (per-path, survives switching files)', () => {
  beforeEach(() => {
    newDoc()
    resetReadonlyMemory()
  })

  it('re-opening a readonly-opened path without the flag stays readonly', () => {
    // The Finder double-click bug: file opened readonly, user switches to
    // another file via the sidebar (openDoc without the flag), then back —
    // the readonly state must follow the path, not the call site.
    openDoc('/tmp/a.md', '# A', true)
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/a.md', '# A') // sidebar switch: no readonly arg
    expect(get(doc).readonly).toBe(true)
  })

  it('a path never opened readonly opens editable', () => {
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
  })

  it('enableEditing clears the memory: the path re-opens editable', () => {
    openDoc('/tmp/a.md', '# A', true)
    enableEditing()
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
  })

  it('enterReadonly (manual toggle) persists across a switch too', () => {
    openDoc('/tmp/a.md', '# A')
    enterReadonly()
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(true)
  })

  it('markSaved clears the memory (a completed write proves edit intent)', () => {
    openDoc('/tmp/a.md', '# A', true)
    markSaved('/tmp/a.md', '# A')
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
  })

  it('revertBuffer clears the memory (a revert makes the buffer editable)', () => {
    openDoc('/tmp/a.md', '# A', true)
    enableEditing() // History revert is disabled while readonly; lift first
    enterReadonly()
    revertBuffer('# older A')
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
  })

  it('retargetPath moves the memory with a renamed file', () => {
    openDoc('/tmp/a.md', '# A', true)
    retargetPath('/tmp/a.md', '/tmp/renamed.md')
    openDoc('/tmp/b.md', '# B')
    openDoc('/tmp/renamed.md', '# A')
    expect(get(doc).readonly).toBe(true)
  })

  it('retargetPath moves the memory when an ancestor folder moves', () => {
    openDoc('/ws/docs/a.md', '# A', true)
    retargetPath('/ws/docs', '/ws/notes')
    openDoc('/tmp/b.md', '# B')
    openDoc('/ws/notes/a.md', '# A')
    expect(get(doc).readonly).toBe(true)
  })

  it('detachIfAffected clears the memory for the detached path', () => {
    openDoc('/tmp/a.md', '# A', true)
    detachIfAffected(['/tmp/a.md'])
    openDoc('/tmp/a.md', '# A')
    expect(get(doc).readonly).toBe(false)
  })
})

describe('adoptNormalization (normalization baseline)', () => {
  beforeEach(() => {
    newDoc()
    resetReadonlyMemory()
  })

  it('adoptNormalization keeps the buffer CLEAN and remembers the baseline', () => {
    // The Crepe editor's first (debounced) emission for an untouched buffer is
    // its re-serialization of what we loaded — not a user edit. Adopting it
    // must not dirty the doc (the phantom-"Edited" bug).
    openDoc('/tmp/a.md', '* bullet\n')
    adoptNormalization('- bullet\n')
    const s = get(doc)
    expect(s.content).toBe('- bullet\n')
    expect(s.savedContent).toBe('* bullet\n') // disk truth untouched
    expect(isDirty(s)).toBe(false)
  })

  it('a real edit after adoption reads dirty; undoing back to the baseline reads clean', () => {
    openDoc('/tmp/a.md', '* bullet\n')
    adoptNormalization('- bullet\n')
    edit('- bullet\n- more\n')
    expect(isDirty(get(doc))).toBe(true)
    edit('- bullet\n')
    expect(isDirty(get(doc))).toBe(false)
  })

  it('adoptNormalization refuses a dirty buffer (only untouched loads adopt)', () => {
    openDoc('/tmp/a.md', '# A')
    edit('# A typed')
    adoptNormalization('# A normalized')
    const s = get(doc)
    expect(s.content).toBe('# A typed')
    expect(isDirty(s)).toBe(true)
  })

  it('adoptNormalization refuses a readonly buffer', () => {
    openDoc('/tmp/a.md', '# A', true)
    adoptNormalization('# A normalized')
    expect(get(doc).content).toBe('# A')
  })

  it('opening another file clears the baseline', () => {
    openDoc('/tmp/a.md', '* x\n')
    adoptNormalization('- x\n')
    openDoc('/tmp/b.md', '# B')
    const s = get(doc)
    expect(s.normalized).toBeNull()
    expect(isDirty(s)).toBe(false)
  })

  it('saving the normalized content reads clean afterwards', () => {
    openDoc('/tmp/a.md', '* x\n')
    adoptNormalization('- x\n')
    markSaved('/tmp/a.md', '- x\n')
    expect(isDirty(get(doc))).toBe(false)
  })
})
