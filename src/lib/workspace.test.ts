import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
// window is imported by initWorkspace (onFocusChanged); stub it so the module loads.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}))

import {
  isMarkdownFile,
  workspace,
  openWorkspace,
  refreshWorkspace,
  restoreWorkspace,
  type WorkspaceDir,
} from './workspace'
import { workspaceName } from './ui'
import { errorMessage } from './errors'

const tree = (name: string): WorkspaceDir => ({
  name,
  path: `/ws/${name}`,
  dirs: [],
  files: [],
  truncated: false,
})

beforeEach(() => {
  invoke.mockReset()
  workspace.set({ root: null, tree: null })
  workspaceName.set(null)
  errorMessage.set(null)
})

describe('isMarkdownFile', () => {
  it.each([
    ['a.md', true],
    ['a.markdown', true],
    ['A.MD', true],
    ['README.MARKDOWN', true],
    ['a.mdx', false],
    ['logo.svg', false],
    ['Makefile', false],
    ['a.md.bak', false],
    ['noext', false],
  ])('%s -> %s', (name, expected) => {
    expect(isMarkdownFile(name)).toBe(expected)
  })
})

describe('openWorkspace', () => {
  it('sets root + tree and the header breadcrumb name on a pick', async () => {
    invoke.mockResolvedValue({ root: '/ws/notes', tree: tree('notes') })
    await openWorkspace()
    expect(invoke).toHaveBeenCalledWith('open_workspace_dialog')
    expect(get(workspace).root).toBe('/ws/notes')
    expect(get(workspace).tree?.name).toBe('notes')
    expect(get(workspaceName)).toBe('notes')
  })

  it('leaves the store untouched when the dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    await openWorkspace()
    expect(get(workspace).root).toBeNull()
    expect(get(workspaceName)).toBeNull()
  })

  it('reports an error when the dialog fails', async () => {
    invoke.mockRejectedValue('boom')
    await openWorkspace()
    expect(get(errorMessage)).toContain('workspace')
    expect(get(workspace).root).toBeNull()
  })
})

describe('refreshWorkspace', () => {
  it('is a no-op when no workspace is open', async () => {
    await refreshWorkspace()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('re-walks the current root and replaces the tree', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    const fresh = tree('notes')
    fresh.files = [{ name: 'new.md', path: '/ws/notes/new.md' }]
    invoke.mockResolvedValue({ root: '/ws/notes', tree: fresh })
    await refreshWorkspace()
    expect(invoke).toHaveBeenCalledWith('list_workspace', { root: '/ws/notes' })
    expect(get(workspace).tree?.files[0].name).toBe('new.md')
  })

  it('keeps the stale tree and reports on a list error', async () => {
    const stale = tree('notes')
    workspace.set({ root: '/ws/notes', tree: stale })
    invoke.mockRejectedValue('gone')
    await refreshWorkspace()
    expect(get(workspace).tree).toBe(stale)
    expect(get(errorMessage)).toContain('workspace')
  })
})

describe('restoreWorkspace', () => {
  it('adopts a restored workspace and sets the breadcrumb', async () => {
    invoke.mockResolvedValue({ root: '/ws/prev', tree: tree('prev') })
    await restoreWorkspace()
    expect(invoke).toHaveBeenCalledWith('restore_workspace')
    expect(get(workspace).root).toBe('/ws/prev')
    expect(get(workspaceName)).toBe('prev')
  })

  it('leaves the store empty when there is nothing to restore', async () => {
    invoke.mockResolvedValue(null)
    await restoreWorkspace()
    expect(get(workspace).root).toBeNull()
    expect(get(workspaceName)).toBeNull()
  })

  it('swallows restore errors, leaving the store empty', async () => {
    invoke.mockRejectedValue('nope')
    await restoreWorkspace()
    expect(get(workspace).root).toBeNull()
  })
})
