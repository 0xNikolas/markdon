import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
// workspace.ts pulls in window (onFocusChanged) at import; stub so it loads.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}))

import {
  visibleRowPaths,
  folderPaths,
  folderRows,
  pasteTargetDir,
  isSelfOrDescendant,
  selection,
  focused,
  clearSelection,
  clipboard,
  focusRow,
  cutSelection,
  copySelection,
  paste,
  performDelete,
  performRename,
  performMove,
} from './fileops'
import { type WorkspaceDir, workspace } from './workspace'
import { doc, openDoc, newDoc, isDirty, resetReadonlyMemory } from './doc'
import { notice, errorMessage } from './errors'
import { openList } from './openList'

const dir = (name: string, path: string, dirs: WorkspaceDir[] = [], files = []): WorkspaceDir => ({
  name,
  path,
  dirs,
  files,
  truncated: false,
})

// /ws
//   docs/           (expanded)
//     note.md
//   img/            (collapsed)
//     logo.svg
//   readme.md
const tree: WorkspaceDir = dir(
  'ws',
  '/ws',
  [
    dir('docs', '/ws/docs', [], [{ name: 'note.md', path: '/ws/docs/note.md' }] as never),
    dir('img', '/ws/img', [], [{ name: 'logo.svg', path: '/ws/img/logo.svg' }] as never),
  ],
  [{ name: 'readme.md', path: '/ws/readme.md' }] as never,
)

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
})

describe('visibleRowPaths', () => {
  it('lists visible rows in display order, honoring the collapsed map', () => {
    // img is collapsed -> its child logo.svg is excluded.
    expect(visibleRowPaths(tree, { '/ws/img': true })).toEqual([
      '/ws/docs',
      '/ws/docs/note.md',
      '/ws/img',
      '/ws/readme.md',
    ])
  })

  it('includes a collapsed subtree once expanded', () => {
    expect(visibleRowPaths(tree, {})).toContain('/ws/img/logo.svg')
  })

  it('returns [] for a null tree', () => {
    expect(visibleRowPaths(null, {})).toEqual([])
  })
})

describe('folderPaths', () => {
  it('collects every directory path including the root', () => {
    expect(folderPaths(tree)).toEqual(new Set(['/ws', '/ws/docs', '/ws/img']))
  })
})

describe('folderRows', () => {
  it('lists the root then every folder with indentation depth', () => {
    expect(folderRows(tree)).toEqual([
      { path: '/ws', label: 'ws', depth: 0 },
      { path: '/ws/docs', label: 'docs', depth: 1 },
      { path: '/ws/img', label: 'img', depth: 1 },
    ])
  })

  it('returns [] for a null tree', () => {
    expect(folderRows(null)).toEqual([])
  })
})

describe('pasteTargetDir', () => {
  const folders = new Set(['/ws', '/ws/docs', '/ws/img'])

  it('uses the focused folder directly', () => {
    expect(pasteTargetDir('/ws/docs', folders, '/ws')).toBe('/ws/docs')
  })
  it("uses a focused file's parent", () => {
    expect(pasteTargetDir('/ws/docs/note.md', folders, '/ws')).toBe('/ws/docs')
  })
  it('falls back to the workspace root when nothing is focused', () => {
    expect(pasteTargetDir(null, folders, '/ws')).toBe('/ws')
  })
})

describe('isSelfOrDescendant', () => {
  it('matches the folder itself and descendants, segment-safely', () => {
    expect(isSelfOrDescendant('/ws/docs', '/ws/docs')).toBe(true)
    expect(isSelfOrDescendant('/ws/docs/note.md', '/ws/docs')).toBe(true)
    expect(isSelfOrDescendant('/ws/docs2/note.md', '/ws/docs')).toBe(false)
  })
})

describe('workspace root changes clear file-ops state', () => {
  it('resets selection, focused, and clipboard when the root changes', () => {
    focusRow('/ws/docs/note.md')
    cutSelection()
    expect(get(selection).size).toBe(1)
    expect(get(focused)).toBe('/ws/docs/note.md')
    expect(get(clipboard)).not.toBeNull()

    // A different workspace is opened (Open Folder / restore) -- same shape
    // of update `adopt()` performs in workspace.ts.
    workspace.set({ root: '/other', tree: dir('other', '/other') })

    expect(get(selection).size).toBe(0)
    expect(get(focused)).toBeNull()
    expect(get(clipboard)).toBeNull()
  })

  it('does not clear on a same-root refresh (e.g. refreshWorkspace)', () => {
    focusRow('/ws/docs/note.md')
    cutSelection()

    // Same root, new tree object -- what refreshWorkspace's adopt() does.
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') })

    expect(get(selection).size).toBe(1)
    expect(get(focused)).toBe('/ws/docs/note.md')
    expect(get(clipboard)).not.toBeNull()
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

describe('performMove keeps the Open Files strip in sync', () => {
  it('retargets a moved entry to its destination path', async () => {
    openDoc('/ws/readme.md', '# hi')
    openList.set(['/ws/readme.md'])
    invoke.mockResolvedValueOnce('/ws/docs/readme.md').mockResolvedValueOnce({ root: '/ws', tree })
    await performMove(['/ws/readme.md'], '/ws/docs')
    expect(get(openList)).toEqual(['/ws/docs/readme.md'])
    expect(get(doc).path).toBe('/ws/docs/readme.md')
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

describe('clearSelection', () => {
  it('empties the selection and drops the focus anchor', () => {
    selection.set(new Set(['/ws/a.md', '/ws/b.md']))
    focused.set('/ws/a.md')
    clearSelection()
    expect(get(selection).size).toBe(0)
    expect(get(focused)).toBeNull()
  })
})
