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
  clipboard,
  focusRow,
  cutSelection,
  copySelection,
  paste,
  performDelete,
  performRename,
} from './fileops'
import { type WorkspaceDir, workspace } from './workspace'
import { doc, openDoc, newDoc, isDirty } from './doc'
import { notice, errorMessage } from './errors'

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

  it('reports an error and does not detach when the backend rejects', async () => {
    openDoc('/ws/readme.md', '# content')
    invoke.mockRejectedValueOnce('denied').mockResolvedValueOnce({ root: '/ws', tree })
    await performDelete(['/ws/readme.md'])
    expect(get(doc).path).toBe('/ws/readme.md') // untouched
    expect(get(errorMessage)).toContain('delete')
  })
})
