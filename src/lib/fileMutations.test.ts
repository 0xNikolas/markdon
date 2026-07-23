import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { isSelfOrDescendant } from './paths'
import { invoke } from './test-support/tauriMocks'
import { dir, tree } from './test-support/workspaceFixtures'
import { paste, performDelete, performRename, performMove } from './fileMutations'
import { selection, focused, clipboard, focusRow, cutSelection, copySelection } from './fileOpsState'
import { workspace } from './workspace'
import { doc, openDoc, newDoc, isDirty, resetReadonlyMemory } from './doc'
import { notice, errorMessage } from './errors'
import { openList, previewPath } from './openList'
import * as bufferCache from './bufferCache'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ root: '/ws', tree }) // default for refreshWorkspace
  selection.set(new Set())
  focused.set(null)
  clipboard.set(null)
  workspace.set({ root: '/ws', tree })
  newDoc()
  notice.set(null)
  errorMessage.set(null)
  openList.set([])
  previewPath.set(null)
  bufferCache.reset()
})

/** A dirty cached background buffer at `path` (content differs from disk). */
function stashDirty(path: string, content = 'cached edits'): void {
  bufferCache.stash(path, { content, savedContent: 'disk', normalized: null, view: null })
}

// Pins the paths.ts predicate performDelete leans on for clipboard pruning.
describe('isSelfOrDescendant', () => {
  it('matches the folder itself and descendants, segment-safely', () => {
    expect(isSelfOrDescendant('/ws/docs', '/ws/docs')).toBe(true)
    expect(isSelfOrDescendant('/ws/docs/note.md', '/ws/docs')).toBe(true)
    expect(isSelfOrDescendant('/ws/docs2/note.md', '/ws/docs')).toBe(false)
  })
})

describe('clipboard clears after a cut-paste but not a copy-paste', () => {
  it('cut-paste (move) clears the clipboard', async () => {
    focusRow('/ws/docs/note.md')
    cutSelection()
    expect(get(clipboard)).not.toBeNull()
    // invoke: move_entry then list_workspace (refresh)
    invoke.mockResolvedValueOnce('/ws/note.md').mockResolvedValueOnce({ root: '/ws', tree })
    focused.set('/ws') // paste target = root
    await paste()
    expect(get(clipboard)).toBeNull()
    expect(invoke).toHaveBeenCalledWith('move_entry', { src: '/ws/docs/note.md', destDir: '/ws' })
  })

  it('copy-paste keeps the clipboard', async () => {
    focusRow('/ws/readme.md')
    copySelection()
    invoke.mockResolvedValueOnce('/ws/docs/readme.md').mockResolvedValueOnce({ root: '/ws', tree })
    focused.set('/ws/docs')
    await paste()
    expect(get(clipboard)).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith('copy_entry', {
      src: '/ws/readme.md',
      destDir: '/ws/docs',
    })
  })

  it('a partial-failure cut-paste leaves exactly the unprocessed items in the clipboard', async () => {
    // Three items cut; the first move succeeds, the second rejects. The third
    // is never attempted. A retry must only touch what didn't already move.
    selection.set(new Set(['/ws/docs/note.md', '/ws/img/logo.svg', '/ws/readme.md']))
    cutSelection()
    invoke
      .mockResolvedValueOnce('/ws/note.md') // move_entry(note.md) succeeds
      .mockRejectedValueOnce('disk full') // move_entry(logo.svg) fails
      .mockResolvedValueOnce({ root: '/ws', tree }) // refreshWorkspace() after the catch
    focused.set('/ws') // paste target = root
    await paste()
    expect(get(clipboard)).toEqual({
      mode: 'cut',
      paths: ['/ws/img/logo.svg', '/ws/readme.md'],
    })
    expect(get(errorMessage)).toContain('paste')
  })

  it('a fully-failed cut-paste (nothing moved) leaves the clipboard untouched', async () => {
    selection.set(new Set(['/ws/docs/note.md', '/ws/readme.md']))
    cutSelection()
    invoke
      .mockRejectedValueOnce('denied') // move_entry(note.md) fails immediately
      .mockResolvedValueOnce({ root: '/ws', tree }) // refreshWorkspace() after the catch
    focused.set('/ws')
    await paste()
    expect(get(clipboard)).toEqual({
      mode: 'cut',
      paths: ['/ws/docs/note.md', '/ws/readme.md'],
    })
  })
})

describe('performRename follows the open document', () => {
  it('retargets the open doc path on a rename', async () => {
    openDoc('/ws/readme.md', '# hi')
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(get(doc).path).toBe('/ws/guide.md')
    expect(invoke).toHaveBeenCalledWith('rename_entry', {
      path: '/ws/readme.md',
      newName: 'guide.md',
    })
  })
})

describe('performRename keeps the Open Files strip in sync', () => {
  it('retargets the active entry so its row keeps the active highlight', async () => {
    openDoc('/ws/readme.md', '# hi')
    openList.set(['/ws/readme.md', '/ws/docs/note.md'])
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(get(openList)).toEqual(['/ws/guide.md', '/ws/docs/note.md'])
  })

  it('retargets a background (non-active) entry', async () => {
    openDoc('/ws/docs/note.md', '# note')
    openList.set(['/ws/docs/note.md', '/ws/readme.md'])
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(get(openList)).toEqual(['/ws/docs/note.md', '/ws/guide.md'])
  })
})

describe('performRename keeps the preview row in sync', () => {
  it('retargets a previewed file on a rename', async () => {
    openDoc('/ws/readme.md', '# hi')
    previewPath.set('/ws/readme.md')
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(get(previewPath)).toBe('/ws/guide.md')
  })

  it('follows a renamed ancestor folder of the preview', async () => {
    previewPath.set('/ws/docs/note.md')
    invoke.mockResolvedValueOnce('/ws/pages').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/docs', 'pages')
    expect(get(previewPath)).toBe('/ws/pages/note.md')
  })

  it('leaves an unrelated preview untouched', async () => {
    previewPath.set('/ws/docs/note.md')
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(get(previewPath)).toBe('/ws/docs/note.md')
  })
})

describe('performMove keeps the Open Files strip in sync', () => {
  it('retargets a moved entry to its destination path', async () => {
    openDoc('/ws/readme.md', '# hi')
    openList.set(['/ws/readme.md'])
    invoke.mockResolvedValueOnce('/ws/docs/readme.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performMove(['/ws/readme.md'], '/ws/docs')
    expect(get(openList)).toEqual(['/ws/docs/readme.md'])
    expect(get(doc).path).toBe('/ws/docs/readme.md')
  })

  it('retargets a moved previewed file too', async () => {
    openDoc('/ws/readme.md', '# hi')
    previewPath.set('/ws/readme.md')
    invoke.mockResolvedValueOnce('/ws/docs/readme.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performMove(['/ws/readme.md'], '/ws/docs')
    expect(get(previewPath)).toBe('/ws/docs/readme.md')
  })
})

describe('cut-paste keeps the Open Files strip in sync', () => {
  it('retargets the moved entry', async () => {
    openDoc('/ws/docs/note.md', '# note')
    openList.set(['/ws/docs/note.md'])
    focusRow('/ws/docs/note.md')
    cutSelection()
    invoke.mockResolvedValueOnce('/ws/note.md').mockResolvedValueOnce({ root: '/ws', tree })
    focused.set('/ws')
    await paste()
    expect(get(openList)).toEqual(['/ws/note.md'])
  })

  it('retargets a cut-pasted previewed file', async () => {
    openDoc('/ws/docs/note.md', '# note')
    previewPath.set('/ws/docs/note.md')
    focusRow('/ws/docs/note.md')
    cutSelection()
    invoke.mockResolvedValueOnce('/ws/note.md').mockResolvedValueOnce({ root: '/ws', tree })
    focused.set('/ws')
    await paste()
    expect(get(previewPath)).toBe('/ws/note.md')
  })
})

describe('performDelete', () => {
  it('detaches the open doc to Untitled and posts a notice when its file is trashed', async () => {
    openDoc('/ws/readme.md', '# content')
    // delete_entries resolves void, then list_workspace refresh
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    const s = get(doc)
    expect(s.path).toBeNull()
    expect(s.content).toBe('# content') // nothing lost
    expect(isDirty(s)).toBe(true)
    expect(get(notice)).toContain('Trash')
  })

  it('leaves an unrelated open doc alone', async () => {
    openDoc('/ws/keep.md', '# keep')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(doc).path).toBe('/ws/keep.md')
    expect(get(notice)).toBeNull()
  })

  it('does not detach a doc opened mid-flight — decides against live state, not a pre-await snapshot (DEFECT A2)', async () => {
    // The doc that is open when performDelete is CALLED is the one being trashed.
    openDoc('/ws/readme.md', '# original')
    // delete_entries stays pending until we resolve it; refreshWorkspace uses the default mock.
    let resolveDelete!: () => void
    const deleteGate = new Promise<void>((r) => {
      resolveDelete = () => r()
    })
    invoke.mockReturnValueOnce(deleteGate)
    const pending = performDelete(['/ws/readme.md'])
    // The user switches to a DIFFERENT file while the delete is in flight.
    openDoc('/ws/keep.md', '# keep')
    resolveDelete()
    await pending
    const s = get(doc)
    // The newly opened doc is unaffected by a delete of a different file.
    expect(s.path).toBe('/ws/keep.md') // NOT detached to Untitled
    expect(s.savedContent).toBe('# keep') // intact
    expect(isDirty(s)).toBe(false)
    expect(get(notice)).toBeNull() // no bogus "moved to Trash" notice
  })

  it('reports an error and does not detach when the backend rejects', async () => {
    openDoc('/ws/readme.md', '# content')
    invoke.mockRejectedValueOnce('denied').mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(doc).path).toBe('/ws/readme.md') // untouched
    expect(get(errorMessage)).toContain('delete')
  })

  it('drops the trashed active entry from the Open Files strip', async () => {
    openDoc('/ws/readme.md', '# content')
    openList.set(['/ws/readme.md', '/ws/docs/note.md'])
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(openList)).toEqual(['/ws/docs/note.md'])
  })

  it('drops a trashed background entry and every entry nested under a trashed folder', async () => {
    openDoc('/ws/readme.md', '# keep open')
    openList.set(['/ws/readme.md', '/ws/docs/note.md', '/ws/img/logo.svg'])
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(get(openList)).toEqual(['/ws/readme.md', '/ws/img/logo.svg'])
  })

  it('clears the preview row when the previewed file is trashed directly', async () => {
    previewPath.set('/ws/readme.md')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(previewPath)).toBeNull()
  })

  it('clears the preview row when it falls inside a trashed subtree', async () => {
    previewPath.set('/ws/docs/note.md')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(get(previewPath)).toBeNull()
  })

  it('leaves an unrelated preview row alone (segment-safe: /ws/docs2 vs /ws/docs)', async () => {
    previewPath.set('/ws/docs2/note.md')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(get(previewPath)).toBe('/ws/docs2/note.md')
  })

  it('leaves the preview untouched when the backend rejects', async () => {
    previewPath.set('/ws/readme.md')
    invoke.mockRejectedValueOnce('denied').mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(previewPath)).toBe('/ws/readme.md')
  })

  it('leaves the Open Files strip untouched when the backend rejects', async () => {
    openDoc('/ws/other.md', '# other')
    openList.set(['/ws/readme.md'])
    invoke.mockRejectedValueOnce('denied').mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(openList)).toEqual(['/ws/readme.md'])
  })

  it('prunes readonly memory for a deleted file that is NOT the open doc (DEFECT A3)', async () => {
    resetReadonlyMemory()
    // A file was locked read-only, then the user switched to a different doc.
    openDoc('/ws/locked.md', '# locked', true)
    openDoc('/ws/keep.md', '# keep') // different doc now open
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/locked.md'])
    // Re-creating a file at the same path and opening it fresh must not
    // resurrect the stale readonly mark.
    openDoc('/ws/locked.md', '# recreated')
    expect(get(doc).readonly).toBe(false)
  })

  it('prunes readonly memory for descendants of a deleted folder (DEFECT A3)', async () => {
    resetReadonlyMemory()
    openDoc('/ws/docs/note.md', '# note', true)
    openDoc('/ws/keep.md', '# keep')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    openDoc('/ws/docs/note.md', '# recreated')
    expect(get(doc).readonly).toBe(false)
  })
})

describe('buffer cache follows mutations', () => {
  it('performRename retargets a cached background buffer (dirty edits follow the file)', async () => {
    stashDirty('/ws/readme.md')
    invoke.mockResolvedValueOnce('/ws/guide.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/readme.md', 'guide.md')
    expect(bufferCache.peek('/ws/readme.md')).toBeUndefined()
    expect(bufferCache.peek('/ws/guide.md')?.content).toBe('cached edits')
  })

  it('performRename of an ancestor folder retargets nested cache entries', async () => {
    stashDirty('/ws/docs/note.md')
    invoke.mockResolvedValueOnce('/ws/pages').mockResolvedValueOnce({ root: '/ws', tree })
    await performRename('/ws/docs', 'pages')
    expect(bufferCache.peek('/ws/pages/note.md')?.content).toBe('cached edits')
  })

  it('performMove retargets cached buffers of the moved entries', async () => {
    stashDirty('/ws/readme.md')
    invoke
      .mockResolvedValueOnce('/ws/docs/readme.md')
      .mockResolvedValueOnce({ root: '/ws', tree })
    await performMove(['/ws/readme.md'], '/ws/docs')
    expect(bufferCache.peek('/ws/docs/readme.md')?.content).toBe('cached edits')
  })

  it('cut-paste retargets a cached buffer alongside the move', async () => {
    stashDirty('/ws/readme.md')
    focusRow('/ws/readme.md')
    cutSelection()
    invoke
      .mockResolvedValueOnce('/ws/docs/readme.md')
      .mockResolvedValueOnce({ root: '/ws', tree })
    focused.set('/ws')
    await paste()
    expect(bufferCache.peek('/ws/docs/readme.md')?.content).toBe('cached edits')
  })

  it('performDelete evicts cache entries for trashed paths and their subtrees', async () => {
    stashDirty('/ws/docs/note.md')
    bufferCache.stash('/ws/keep.md', {
      content: 'x',
      savedContent: 'x',
      normalized: null,
      view: null,
    })
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(bufferCache.peek('/ws/docs/note.md')).toBeUndefined()
    expect(bufferCache.peek('/ws/keep.md')).toBeDefined()
  })

  it('performDelete posts a notice when a DIRTY cached buffer is dropped', async () => {
    stashDirty('/ws/docs/note.md')
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(get(notice)).toContain('unsaved changes')
  })

  it('performDelete stays quiet when only CLEAN cached buffers are dropped', async () => {
    bufferCache.stash('/ws/docs/note.md', {
      content: 'x',
      savedContent: 'x',
      normalized: null,
      view: null,
    })
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/docs'])
    expect(get(notice)).toBeNull()
  })
})
