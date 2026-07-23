import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { workspace, type WorkspaceDir, type WorkspaceFile } from './workspace'
import {
  collapsed,
  toggleFolder,
  setFolderCollapsed,
  renaming,
  renameValue,
  startRename,
  cancelRename,
  renameCommit,
  stemLength,
  basename,
} from './treeState'

function dir(
  name: string,
  path: string,
  dirs: WorkspaceDir[] = [],
  files: WorkspaceFile[] = [],
): WorkspaceDir {
  return { name, path, dirs, files, truncated: false }
}

beforeEach(() => {
  workspace.set({ root: null, tree: null })
  collapsed.set({})
  cancelRename()
})

describe('toggleFolder', () => {
  it('toggles a path on and off', () => {
    toggleFolder('/ws/a')
    expect(get(collapsed)['/ws/a']).toBe(true)
    toggleFolder('/ws/a')
    expect(get(collapsed)['/ws/a']).toBe(false)
  })
})

describe('setFolderCollapsed', () => {
  it('sets the state explicitly and idempotently', () => {
    setFolderCollapsed('/ws/a', true)
    expect(get(collapsed)['/ws/a']).toBe(true)
    setFolderCollapsed('/ws/a', true)
    expect(get(collapsed)['/ws/a']).toBe(true)
    setFolderCollapsed('/ws/a', false)
    expect(get(collapsed)['/ws/a']).toBe(false)
  })
})

describe('startRename', () => {
  it('expands every collapsed ancestor and arms the rename', () => {
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') })
    collapsed.set({ '/ws/a': true, '/ws/a/b': true, '/ws/other': true })
    startRename('/ws/a/b/c.md')
    expect(get(collapsed)['/ws/a']).toBe(false)
    expect(get(collapsed)['/ws/a/b']).toBe(false)
    expect(get(collapsed)['/ws/other']).toBe(true) // unrelated folder untouched
    expect(get(renaming)).toBe('/ws/a/b/c.md')
    expect(get(renameValue)).toBe('c.md')
  })

  it('still arms with no workspace root', () => {
    startRename('/tmp/loose.md')
    expect(get(renaming)).toBe('/tmp/loose.md')
    expect(get(renameValue)).toBe('loose.md')
  })
})

describe('cancelRename', () => {
  it('clears the armed path and the live value', () => {
    startRename('/ws/x.md')
    cancelRename()
    expect(get(renaming)).toBeNull()
    expect(get(renameValue)).toBe('')
  })
})

describe('renameCommit', () => {
  it('skips when the path is not the armed row (idempotent teardown blur)', () => {
    expect(renameCommit(null, '/ws/a.md', 'b.md')).toEqual({ kind: 'skip' })
    expect(renameCommit('/ws/other.md', '/ws/a.md', 'b.md')).toEqual({ kind: 'skip' })
  })

  it('cancels on an unchanged name (including surrounding whitespace)', () => {
    expect(renameCommit('/ws/a.md', '/ws/a.md', 'a.md')).toEqual({ kind: 'cancel' })
    expect(renameCommit('/ws/a.md', '/ws/a.md', '  a.md ')).toEqual({ kind: 'cancel' })
  })

  it('cancels on an invalid name (leafNameError)', () => {
    expect(renameCommit('/ws/a.md', '/ws/a.md', '')).toEqual({ kind: 'cancel' })
    expect(renameCommit('/ws/a.md', '/ws/a.md', 'x/y.md')).toEqual({ kind: 'cancel' })
    expect(renameCommit('/ws/a.md', '/ws/a.md', '..')).toEqual({ kind: 'cancel' })
  })

  it('commits a valid changed name, trimmed', () => {
    expect(renameCommit('/ws/a.md', '/ws/a.md', ' b.md ')).toEqual({
      kind: 'commit',
      newName: 'b.md',
    })
  })
})

describe('workspace-switch invalidation', () => {
  it('cancels an in-flight rename when the root changes', () => {
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') })
    startRename('/ws/a.md')
    workspace.set({ root: '/other', tree: dir('other', '/other') })
    expect(get(renaming)).toBeNull()
  })

  it('keeps the rename across a same-root refresh', () => {
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') })
    startRename('/ws/a.md')
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') }) // refreshed tree, same root
    expect(get(renaming)).toBe('/ws/a.md')
  })
})

describe('stemLength', () => {
  it('is the extension-dot offset for ordinary filenames', () => {
    expect(stemLength('notes.md')).toBe(5)
  })

  it('is the full length for dotfiles and extension-less names', () => {
    expect(stemLength('.gitignore')).toBe(10)
    expect(stemLength('README')).toBe(6)
  })
})

describe('basename', () => {
  it('takes the last path segment, tolerating trailing slashes', () => {
    expect(basename('/ws/a/b.md')).toBe('b.md')
    expect(basename('/ws/dir/')).toBe('dir')
  })
})
