import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  doc,
  newDoc,
  edit,
  isDirty,
  openDoc,
  docWith,
  revertBuffer,
  resetReadonlyMemory,
} from './doc'
import {
  open,
  save,
  saveAs,
  openPath,
  openInPreferredTarget,
  openInNewWindow,
  openDrainedEntries,
  stashActive,
  saveCachedBuffer,
  saveAllDirty,
} from './files'
import { errorMessage } from './errors'
import { openList, previewPath } from './openList'
import { conflict } from './fileSync'
import * as bufferCache from './bufferCache'
import { registerBufferFlush, unregisterBufferFlush } from './bufferFlush'
import { settings, DEFAULTS } from './settings'

beforeEach(() => {
  invoke.mockReset()
  newDoc()
  openList.set([])
  previewPath.set(null)
  bufferCache.reset()
  resetReadonlyMemory()
  conflict.set(null)
  settings.set({ ...DEFAULTS }) // openMode: 'tab' (MODE A) unless a test opts in
})

describe('openPath', () => {
  it('loads the given path into the store without a dialog', async () => {
    invoke.mockResolvedValue('# From association')
    await openPath('/tmp/assoc.md')
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/tmp/assoc.md' })
    const s = get(doc)
    expect(s.path).toBe('/tmp/assoc.md')
    expect(s.content).toBe('# From association')
    expect(isDirty(s)).toBe(false)
  })

  it('reports an error when the read fails', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('nope')
    await openPath('/tmp/missing.md')
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('adds the path to the open list on success', async () => {
    invoke.mockResolvedValue('# From association')
    await openPath('/tmp/assoc.md')
    expect(get(openList)).toEqual(['/tmp/assoc.md'])
  })

  it('re-opening an already-listed path does not duplicate it', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/a.md')
    await openPath('/tmp/a.md')
    expect(get(openList)).toEqual(['/tmp/a.md'])
  })

  it('leaves the open list untouched when the read fails', async () => {
    invoke.mockRejectedValue('nope')
    await openPath('/tmp/missing.md')
    expect(get(openList)).toEqual([])
  })
})

describe('openPath preview semantics', () => {
  it('a preview open loads the doc, sets previewPath, and does NOT pin', async () => {
    invoke.mockResolvedValue('# peek')
    await openPath('/tmp/a.md', { preview: true })
    expect(get(doc).path).toBe('/tmp/a.md')
    expect(get(previewPath)).toBe('/tmp/a.md')
    expect(get(openList)).toEqual([])
  })

  it('a new preview replaces the old one (only ever one italic row)', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/a.md', { preview: true })
    await openPath('/tmp/b.md', { preview: true })
    expect(get(previewPath)).toBe('/tmp/b.md')
    expect(get(openList)).toEqual([])
  })

  it('a pinned open of the previewed path promotes it (pin-on-reopen)', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/a.md', { preview: true })
    await openPath('/tmp/a.md')
    expect(get(openList)).toEqual(['/tmp/a.md'])
    expect(get(previewPath)).toBeNull()
  })

  it('preview-opening an already-pinned path stays pinned (no demotion)', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/a.md')
    await openPath('/tmp/a.md', { preview: true })
    expect(get(openList)).toEqual(['/tmp/a.md'])
    expect(get(previewPath)).toBeNull()
  })

  it('a pinned open of a DIFFERENT path leaves an unrelated preview alone', async () => {
    invoke.mockResolvedValue('# body')
    await openPath('/tmp/peek.md', { preview: true })
    await openPath('/tmp/other.md')
    expect(get(previewPath)).toBe('/tmp/peek.md')
    expect(get(openList)).toEqual(['/tmp/other.md'])
  })

  it('leaves the preview slot untouched when the read fails', async () => {
    invoke.mockRejectedValue('nope')
    await openPath('/tmp/missing.md', { preview: true })
    expect(get(previewPath)).toBeNull()
  })

  it('threads readonly through a preview open', async () => {
    invoke.mockResolvedValue('# RO peek')
    await openPath('/tmp/ro.md', { preview: true, readonly: true })
    expect(get(doc).readonly).toBe(true)
    expect(get(previewPath)).toBe('/tmp/ro.md')
  })
})

describe('buffer cache: stash on switch-away (stashActive / openPath)', () => {
  /** read_file returns per-path content; every other command resolves null. */
  function mockFs(fs: Record<string, string>) {
    invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'read_file') {
        const p = (args as { path: string }).path
        if (p in fs) return fs[p]
        throw `no such file: ${p}`
      }
      return null
    })
  }

  it('switching between pinned docs stashes the dirty buffer and restores it', async () => {
    mockFs({ '/tmp/a.md': '# a', '/tmp/b.md': '# b' })
    await openPath('/tmp/a.md')
    edit('# a edited')
    await openPath('/tmp/b.md')
    expect(bufferCache.peek('/tmp/a.md')).toMatchObject({
      content: '# a edited',
      savedContent: '# a',
    })
    await openPath('/tmp/a.md')
    const s = get(doc)
    expect(s.content).toBe('# a edited')
    expect(s.savedContent).toBe('# a') // restored, not re-read as a fresh load
    expect(isDirty(s)).toBe(true)
    expect(bufferCache.peek('/tmp/a.md')).toBeUndefined() // take() consumed it
  })

  it('a cache hit restores synchronously — read_file only reconciles in background', async () => {
    mockFs({ '/tmp/a.md': '# a', '/tmp/b.md': '# b' })
    await openPath('/tmp/a.md')
    edit('# a edited')
    await openPath('/tmp/b.md')
    invoke.mockClear()
    const p = openPath('/tmp/a.md') // NOT awaited: the restore must not need it
    expect(get(doc).content).toBe('# a edited')
    await p
    // The only read is the background reconcile of the restored path.
    const reads = invoke.mock.calls.filter((c) => c[0] === 'read_file')
    expect(reads).toEqual([['read_file', { path: '/tmp/a.md' }]])
  })

  it('a clean preview is dropped on switch-away (volatile, not stashed)', async () => {
    mockFs({ '/tmp/peek.md': '# peek', '/tmp/b.md': '# b' })
    await openPath('/tmp/peek.md', { preview: true })
    await openPath('/tmp/b.md')
    expect(bufferCache.peek('/tmp/peek.md')).toBeUndefined()
  })

  it('a dirty pathed doc NOT in openList is defensively pinned, then stashed', async () => {
    mockFs({ '/tmp/p.md': '# p', '/tmp/b.md': '# b' })
    await openPath('/tmp/p.md', { preview: true })
    edit('# p edited') // App would pin here; the choke-point must not rely on it
    await openPath('/tmp/b.md')
    expect(get(openList)).toContain('/tmp/p.md')
    expect(bufferCache.isCachedDirty('/tmp/p.md')).toBe(true)
  })

  it('the untitled scratch is never stashed (no cache key)', async () => {
    mockFs({ '/tmp/b.md': '# b' })
    newDoc()
    edit('draft')
    stashActive()
    expect(bufferCache.anyCachedDirty()).toEqual([])
  })

  it('a self-switch round-trips the dirty buffer identically', async () => {
    mockFs({ '/tmp/a.md': '# a' })
    await openPath('/tmp/a.md')
    edit('# a edited')
    await openPath('/tmp/a.md')
    const s = get(doc)
    expect(s.content).toBe('# a edited')
    expect(isDirty(s)).toBe(true)
  })

  it('a failed open evicts the speculative stash (the live doc must never also be cached)', async () => {
    mockFs({ '/tmp/a.md': '# a' })
    await openPath('/tmp/a.md')
    edit('# a edited')
    errorMessage.set(null)
    await openPath('/tmp/missing.md')
    expect(get(errorMessage)).toContain('Could not open file')
    expect(get(doc).content).toBe('# a edited') // still live…
    expect(bufferCache.peek('/tmp/a.md')).toBeUndefined() // …and not forked in the cache
  })

  it('a readonly open of a CLEAN cached entry restores read-only', async () => {
    mockFs({ '/tmp/ro.md': '# ro' })
    openList.set(['/tmp/ro.md'])
    bufferCache.stash('/tmp/ro.md', {
      content: '# ro',
      savedContent: '# ro',
      normalized: null,
      view: null,
    })
    await openPath('/tmp/ro.md', { readonly: true })
    expect(get(doc).readonly).toBe(true)
  })

  it('a readonly open of a DIRTY cached entry keeps the edits editable (edits win)', async () => {
    mockFs({ '/tmp/ro.md': '# ro' })
    openList.set(['/tmp/ro.md'])
    bufferCache.stash('/tmp/ro.md', {
      content: '# ro edited',
      savedContent: '# ro',
      normalized: null,
      view: null,
    })
    await openPath('/tmp/ro.md', { readonly: true })
    const s = get(doc)
    expect(s.readonly).toBe(false)
    expect(s.content).toBe('# ro edited')
  })

  it('an external change while cached: clean entry silently reloads on restore', async () => {
    mockFs({ '/tmp/a.md': 'newer from disk' })
    openList.set(['/tmp/a.md'])
    bufferCache.stash('/tmp/a.md', {
      content: 'old',
      savedContent: 'old',
      normalized: null,
      view: null,
    })
    await openPath('/tmp/a.md')
    await vi.waitFor(() => expect(get(doc).content).toBe('newer from disk'))
    expect(isDirty(get(doc))).toBe(false)
  })

  it('an external change while cached: dirty entry raises the conflict bar', async () => {
    mockFs({ '/tmp/a.md': 'theirs' })
    openList.set(['/tmp/a.md'])
    bufferCache.stash('/tmp/a.md', {
      content: 'mine',
      savedContent: 'base',
      normalized: null,
      view: null,
    })
    await openPath('/tmp/a.md')
    expect(get(doc).content).toBe('mine') // the user's edits stay in the buffer
    await vi.waitFor(() => expect(get(conflict)).toBe('theirs'))
  })

  it("the Don't-Save close sequence destroys the buffer for good — no re-pin, no resurrected stash", async () => {
    // Mirrors App.svelte onCloseFile's guarded action after "Don't Save":
    // revert the still-dirty doc to disk truth FIRST, then unpin + evict and
    // switch to the neighbour. The revert is load-bearing — without it,
    // openPath's stashActive sees a dirty doc no longer in openList,
    // defensively re-pins it and stashes the buffer the user just discarded
    // (the closed tab resurrects, and a later Save-all writes the discarded
    // edits to disk).
    mockFs({ '/tmp/keep.md': '# keep', '/tmp/gone.md': '# gone' })
    await openPath('/tmp/keep.md')
    await openPath('/tmp/gone.md')
    edit('# gone edited')
    const cur = get(doc)
    expect(isDirty(cur)).toBe(true)
    revertBuffer(cur.savedContent) // Don't Save: back to disk truth
    openList.update((l) => l.filter((p) => p !== '/tmp/gone.md'))
    bufferCache.evict('/tmp/gone.md')
    await openPath('/tmp/keep.md')
    expect(get(doc).path).toBe('/tmp/keep.md')
    expect(get(openList)).toEqual(['/tmp/keep.md']) // gone.md was NOT re-pinned
    expect(bufferCache.peek('/tmp/gone.md')).toBeUndefined() // discarded means gone
    expect(bufferCache.anyCachedDirty()).toEqual([])
  })
})

describe('saveCachedBuffer', () => {
  const dirtyEntry = { content: 'edited', savedContent: 'base', normalized: null, view: null }

  it('writes the cached content, marks the entry clean, and records history', async () => {
    invoke.mockResolvedValue(undefined)
    bufferCache.stash('/tmp/bg.md', { ...dirtyEntry })
    await expect(saveCachedBuffer('/tmp/bg.md')).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/bg.md', contents: 'edited' })
    expect(invoke).toHaveBeenCalledWith('record_history', { path: '/tmp/bg.md', trigger: 'save' })
    expect(bufferCache.isCachedDirty('/tmp/bg.md')).toBe(false)
    expect(bufferCache.peek('/tmp/bg.md')?.savedContent).toBe('edited')
  })

  it('reports and returns false on a write failure, keeping the entry dirty', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('disk full')
    bufferCache.stash('/tmp/bg.md', { ...dirtyEntry })
    await expect(saveCachedBuffer('/tmp/bg.md')).resolves.toBe(false)
    expect(get(errorMessage)).toContain('Could not save file')
    expect(bufferCache.isCachedDirty('/tmp/bg.md')).toBe(true)
  })

  it('is trivially true for a clean or absent entry — no write', async () => {
    bufferCache.stash('/tmp/clean.md', {
      content: 'x',
      savedContent: 'x',
      normalized: null,
      view: null,
    })
    await expect(saveCachedBuffer('/tmp/clean.md')).resolves.toBe(true)
    await expect(saveCachedBuffer('/tmp/absent.md')).resolves.toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })
})

describe('saveAllDirty', () => {
  it('saves the dirty active doc AND every dirty cached buffer', async () => {
    invoke.mockResolvedValue(undefined)
    doc.set(docWith({ path: '/tmp/active.md', content: 'live', savedContent: 'old' }))
    bufferCache.stash('/tmp/bg.md', {
      content: 'bg edit',
      savedContent: 'bg',
      normalized: null,
      view: null,
    })
    await expect(saveAllDirty()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/active.md', contents: 'live' })
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/bg.md', contents: 'bg edit' })
    expect(isDirty(get(doc))).toBe(false)
    expect(bufferCache.anyCachedDirty()).toEqual([])
  })

  it('returns false when any write fails, leaving that buffer dirty', async () => {
    invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'write_file' && (args as { path: string }).path === '/tmp/bad.md') {
        throw 'disk full'
      }
      return undefined
    })
    doc.set(docWith({ path: '/tmp/active.md', content: 'live', savedContent: 'old' }))
    bufferCache.stash('/tmp/bad.md', {
      content: 'edit',
      savedContent: 'base',
      normalized: null,
      view: null,
    })
    await expect(saveAllDirty()).resolves.toBe(false)
    expect(isDirty(get(doc))).toBe(false) // the active save still landed
    expect(bufferCache.isCachedDirty('/tmp/bad.md')).toBe(true) // retry has the set intact
  })

  it('a cancelled Save As for a dirty untitled reports not-clean', async () => {
    newDoc()
    edit('draft')
    invoke.mockResolvedValue(null) // save_file_dialog cancelled
    await expect(saveAllDirty()).resolves.toBe(false)
  })

  it('is trivially true when nothing is dirty', async () => {
    await expect(saveAllDirty()).resolves.toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })
})

describe('open', () => {
  it('loads the file picked via the Rust dialog into the store', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(invoke).toHaveBeenCalledWith('open_file_dialog')
    const s = get(doc)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# Loaded')
    expect(isDirty(s)).toBe(false)
  })

  it('does nothing when the dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    await open()
    expect(get(doc).path).toBeNull()
  })

  it('adds the picked path to the open list', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(get(openList)).toEqual(['/tmp/a.md'])
  })

  it('leaves the open list untouched when the dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    await open()
    expect(get(openList)).toEqual([])
  })

  it('re-picking the ACTIVE dirty file preserves the edits and never forks it into the cache', async () => {
    // File > Open on the already-active path is a natural "reload" gesture.
    // It must route through openPath's lossless stash-then-take: the naive
    // stashActive();openDoc() pair would stash the dirty live buffer under p
    // and then reload p clean from disk — a dirty cache FORK of the LIVE doc
    // (phantom dirty dot, spurious close prompt, and a window-close Save-all
    // writing the stale fork over any newer save).
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog'
        ? { path: '/tmp/active.md', content: '# disk' }
        : cmd === 'read_file'
          ? '# disk'
          : undefined,
    )
    openDoc('/tmp/active.md', '# disk')
    openList.set(['/tmp/active.md'])
    edit('# disk edited')
    await open()
    const s = get(doc)
    expect(s.path).toBe('/tmp/active.md')
    expect(s.content).toBe('# disk edited') // the live buffer survives the self-re-pick
    expect(isDirty(s)).toBe(true)
    // The LIVE doc must never also sit in the cache (openPath's documented
    // invariant): no forked entry, nothing cached-dirty.
    expect(bufferCache.peek('/tmp/active.md')).toBeUndefined()
    expect(bufferCache.anyCachedDirty()).toEqual([])
    // And a window-close Save-all writes ONLY the live buffer — no stale fork.
    edit('# disk edited v2')
    await expect(saveAllDirty()).resolves.toBe(true)
    const writes = invoke.mock.calls.filter((c) => c[0] === 'write_file')
    expect(writes).toEqual([
      ['write_file', { path: '/tmp/active.md', contents: '# disk edited v2' }],
    ])
  })

  it('a pick that is a CACHED background tab restores its buffer, not the dialog content', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog'
        ? { path: '/tmp/cached.md', content: '# disk' }
        : cmd === 'read_file'
          ? '# disk'
          : undefined,
    )
    openList.set(['/tmp/cached.md'])
    bufferCache.stash('/tmp/cached.md', {
      content: '# dirty edits',
      savedContent: '# disk',
      normalized: null,
      view: null,
    })
    await open()
    const s = get(doc)
    expect(s.path).toBe('/tmp/cached.md')
    expect(s.content).toBe('# dirty edits') // never clobbered by the fresh read
    expect(isDirty(s)).toBe(true)
  })
})

describe('save', () => {
  it('writes to the existing path and records the saved content', async () => {
    // arrange a document already backed by a path, with unsaved edits
    doc.set(docWith({ path: '/tmp/a.md', content: 'body', savedContent: 'old' }))
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/a.md', contents: 'body' })
    expect(isDirty(get(doc))).toBe(false)
  })

  it('falls back to Save As when there is no path', async () => {
    newDoc()
    edit('draft')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/new.md' : undefined,
    )
    await save()
    expect(invoke).toHaveBeenCalledWith('save_file_dialog', { defaultPath: 'untitled.md' })
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/new.md', contents: 'draft' })
    expect(get(doc).path).toBe('/tmp/new.md')
    expect(isDirty(get(doc))).toBe(false)
  })

  it('keeps edits typed during an in-flight save dirty', async () => {
    doc.set(docWith({ path: '/tmp/a.md', content: 'v1', savedContent: 'v0' }))
    invoke.mockImplementation(async () => {
      edit('v2') // the user types while write_file is in flight
    })
    await save()
    const s = get(doc)
    expect(s.content).toBe('v2')
    expect(s.savedContent).toBe('v1') // what actually hit disk
    expect(isDirty(s)).toBe(true)
  })
})

describe('saveAs', () => {
  it('does nothing when the save dialog is cancelled', async () => {
    newDoc()
    edit('draft')
    invoke.mockResolvedValue(null)
    await saveAs()
    expect(invoke).toHaveBeenCalledTimes(1) // only the dialog, no write_file
    expect(isDirty(get(doc))).toBe(true)
  })

  it('reports an error when the dialog itself fails', async () => {
    errorMessage.set(null)
    newDoc()
    edit('draft')
    invoke.mockRejectedValue('no display server')
    await saveAs()
    expect(get(errorMessage)).toContain('Could not save file')
  })

  it('adds the newly saved-as path to the open list', async () => {
    newDoc()
    edit('draft')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/new.md' : undefined,
    )
    await saveAs()
    expect(get(openList)).toEqual(['/tmp/new.md'])
  })

  it("clears a preview that pointed at the doc's old path (the buffer moved away)", async () => {
    openDoc('/tmp/peek.md', '# peek')
    previewPath.set('/tmp/peek.md')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/copy.md' : undefined,
    )
    await saveAs()
    expect(get(previewPath)).toBeNull()
    expect(get(openList)).toEqual(['/tmp/copy.md'])
  })

  it('leaves an unrelated preview alone', async () => {
    openDoc('/tmp/a.md', '# a')
    previewPath.set('/tmp/other-peek.md')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/copy.md' : undefined,
    )
    await saveAs()
    expect(get(previewPath)).toBe('/tmp/other-peek.md')
  })

  it('evicts a cached background tab the Save As just overwrote', async () => {
    // The stale cache entry must not later restore pre-overwrite content.
    openList.set(['/tmp/target.md'])
    bufferCache.stash('/tmp/target.md', {
      content: 'stale',
      savedContent: 'stale',
      normalized: null,
      view: null,
    })
    newDoc()
    edit('overwriting draft')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/target.md' : undefined,
    )
    await saveAs()
    expect(bufferCache.peek('/tmp/target.md')).toBeUndefined()
    expect(get(doc).path).toBe('/tmp/target.md')
  })
})

describe('openInPreferredTarget', () => {
  it("MODE A ('tab'): delegates to the caller-supplied in-place opener", () => {
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    expect(opened).toEqual(['/tmp/a.md'])
    expect(invoke).not.toHaveBeenCalledWith('open_document_window', expect.anything())
  })

  it("MODE B ('window'): spawns a new window and does NOT open in place", () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockResolvedValue(undefined)
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/tmp/a.md',
      readonly: false,
    })
    expect(opened).toEqual([]) // focused window keeps its own doc
  })

  it('MODE B: a readonly open (Finder association) carries the flag into the hand-off', () => {
    // The Finder-open safety net must survive the window hand-off: the spawned
    // window opens the file read-only (banner + Enable editing), exactly like
    // MODE A's in-place openPath(p, true).
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockResolvedValue(undefined)
    openInPreferredTarget('/tmp/a.md', () => {}, true)
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/tmp/a.md',
      readonly: true,
    })
  })

  it("MODE B: falls back to opening in place if spawning the window fails", async () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    errorMessage.set(null)
    invoke.mockRejectedValue('no window config to clone')
    const opened: string[] = []
    openInPreferredTarget('/tmp/a.md', (p) => opened.push(p))
    await vi.waitFor(() => expect(opened).toEqual(['/tmp/a.md']))
    expect(get(errorMessage)).toContain('Could not open a new window')
  })

  it("MODE B: File > Open routes the picked file to a new window", async () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'open_file_dialog' ? { path: '/tmp/a.md', content: '# Loaded' } : undefined,
    )
    await open()
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/tmp/a.md',
      readonly: false,
    })
    // The focused window's own doc is untouched (the new window loads it).
    expect(get(doc).path).toBeNull()
    expect(get(openList)).toEqual([])
  })
})

describe('openDrainedEntries', () => {
  const entry = (path: string, readonly = false) => ({ path, readonly })

  it('is a no-op on an empty drain', () => {
    openDrainedEntries([], () => {})
    expect(invoke).not.toHaveBeenCalled()
    expect(get(openList)).toEqual([])
  })

  it("MODE A ('tab'): the first entry opens in place and becomes active; the rest pin without stealing activation", async () => {
    invoke.mockResolvedValue('# body')
    openDrainedEntries([entry('/a.md'), entry('/b.md'), entry('/c.md')], (p, readonly) =>
      openPath(p, { readonly }),
    )
    await vi.waitFor(() => expect(get(doc).path).toBe('/a.md'))
    // Every drained path surfaces in the strip — nothing after the first is lost.
    expect([...get(openList)].sort()).toEqual(['/a.md', '/b.md', '/c.md'])
    expect(get(doc).path).toBe('/a.md')
  })

  it('MODE A: threads the first entry\'s OWN readonly flag into the in-place closure', async () => {
    invoke.mockResolvedValue('# finder open')
    openDrainedEntries([entry('/finder.md', true)], (p, readonly) => openPath(p, { readonly }))
    await vi.waitFor(() => expect(get(doc).path).toBe('/finder.md'))
    expect(get(doc).readonly).toBe(true)
  })

  it('MODE A: an argv (editable) first entry opens editable — never hardcoded readonly', async () => {
    invoke.mockResolvedValue('# argv open')
    openDrainedEntries([entry('/argv.md', false)], (p, readonly) => openPath(p, { readonly }))
    await vi.waitFor(() => expect(get(doc).path).toBe('/argv.md'))
    expect(get(doc).readonly).toBe(false)
  })

  it("MODE B ('window'): every entry gets its own window, each honoring its per-entry readonly", () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockResolvedValue(undefined)
    const inPlace: string[] = []
    openDrainedEntries(
      [entry('/finder.md', true), entry('/argv.md', false)],
      (p) => inPlace.push(p),
    )
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/finder.md',
      readonly: true,
    })
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/argv.md',
      readonly: false,
    })
    // The focused window's own doc/list stay untouched in window mode.
    expect(inPlace).toEqual([])
    expect(get(openList)).toEqual([])
  })

  it('MODE B: a failed spawn of a REST entry degrades to a pinned strip row, not an in-place open', async () => {
    settings.set({ ...DEFAULTS, openMode: 'window' })
    invoke.mockRejectedValue('no window config to clone')
    const inPlace: string[] = []
    openDrainedEntries([entry('/a.md'), entry('/b.md')], (p) => inPlace.push(p))
    // First entry falls back to the caller's in-place closure; the rest pin.
    await vi.waitFor(() => expect(inPlace).toEqual(['/a.md']))
    await vi.waitFor(() => expect(get(openList)).toEqual(['/b.md']))
  })
})

describe('openInNewWindow', () => {
  it("spawns a doc window regardless of openMode ('tab' here) and never readonly", async () => {
    invoke.mockResolvedValue(undefined)
    await openInNewWindow('/tmp/a.md')
    expect(invoke).toHaveBeenCalledWith('open_document_window', {
      path: '/tmp/a.md',
      readonly: false,
    })
    // Explicit window opens leave this window's doc/list/preview untouched.
    expect(get(doc).path).toBeNull()
    expect(get(openList)).toEqual([])
    expect(get(previewPath)).toBeNull()
  })

  it('reports a spawn failure without any in-place fallback', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('no window config to clone')
    await openInNewWindow('/tmp/a.md')
    expect(get(errorMessage)).toContain('Could not open a new window')
    expect(get(doc).path).toBeNull() // the user asked for a window, not this one
  })
})

describe('error handling', () => {
  it('reports an error when read_file rejects', async () => {
    errorMessage.set(null)
    invoke.mockRejectedValue('boom')
    await openPath('/tmp/a.md')
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('reports an error when write_file rejects and keeps dirty', async () => {
    errorMessage.set(null)
    doc.set(docWith({ path: '/tmp/a.md', content: 'body', savedContent: 'old' }))
    invoke.mockRejectedValue('disk full')
    await save()
    expect(get(errorMessage)).toContain('Could not save file')
    expect(isDirty(get(doc))).toBe(true)
  })
})

describe('readonly', () => {
  it('openPath threads the readonly flag into the store', async () => {
    invoke.mockResolvedValue('# RO')
    await openPath('/tmp/ro.md', { readonly: true })
    expect(get(doc).readonly).toBe(true)
  })

  it('openPath defaults to editable', async () => {
    invoke.mockResolvedValue('# RW')
    await openPath('/tmp/rw.md')
    expect(get(doc).readonly).toBe(false)
  })

  it('save is a no-op while readonly', async () => {
    openDoc('/tmp/ro.md', 'body', true)
    await save()
    expect(invoke).not.toHaveBeenCalledWith('write_file', expect.anything())
  })

  it('saveAs from a readonly doc retargets to the copy and enables editing', async () => {
    openDoc('/tmp/ro.md', 'body', true)
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/copy.md' : undefined,
    )
    await saveAs()
    const s = get(doc)
    expect(s.path).toBe('/tmp/copy.md')
    expect(s.readonly).toBe(false)
    expect(isDirty(s)).toBe(false)
  })
})

describe('flush-before-read (the stale-save window)', () => {
  // Simulates the editors' debounced serialization: the registered flush
  // holds keystrokes that have NOT yet landed in doc.content. Every read
  // point below must run it before trusting the store.
  let flush: (() => void) | null = null
  function pendingKeystrokes(md: string) {
    flush = () => edit(md)
    registerBufferFlush(flush)
  }
  afterEach(() => {
    if (flush) unregisterBufferFlush(flush)
    flush = null
  })

  it('save() lands the pending serialization before writing', async () => {
    openDoc('/tmp/a.md', 'saved')
    edit('saved plus older emission')
    pendingKeystrokes('saved plus newest keystrokes')
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', {
      path: '/tmp/a.md',
      contents: 'saved plus newest keystrokes',
    })
    // …and the buffer is clean afterwards (no re-dirty when the debounced
    // emission would have landed post-save).
    expect(get(doc).savedContent).toBe('saved plus newest keystrokes')
    expect(isDirty(get(doc))).toBe(false)
  })

  it('saveAs() flushes before reading the buffer', async () => {
    openDoc('/tmp/a.md', 'saved')
    pendingKeystrokes('newest')
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/tmp/copy.md' : undefined,
    )
    await saveAs()
    expect(invoke).toHaveBeenCalledWith('write_file', {
      path: '/tmp/copy.md',
      contents: 'newest',
    })
  })

  it('stashActive() flushes so the cache never snapshots a stale buffer', () => {
    openDoc('/tmp/a.md', 'saved')
    openList.set(['/tmp/a.md'])
    pendingKeystrokes('newest')
    stashActive()
    expect(bufferCache.peek('/tmp/a.md')?.content).toBe('newest')
  })

  it('saveAllDirty() flushes before the dirty check, not just inside save()', async () => {
    // Without the up-front flush the active doc reads CLEAN here and is
    // skipped entirely — the pending keystrokes would die with the window.
    openDoc('/tmp/a.md', 'saved')
    pendingKeystrokes('saved plus pending')
    invoke.mockResolvedValue(undefined)
    const allClean = await saveAllDirty()
    expect(allClean).toBe(true)
    expect(invoke).toHaveBeenCalledWith('write_file', {
      path: '/tmp/a.md',
      contents: 'saved plus pending',
    })
  })

  it('a flush with nothing registered leaves every path working (no-op)', async () => {
    openDoc('/tmp/a.md', 'saved')
    edit('typed')
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/a.md', contents: 'typed' })
  })
})
