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
  fileIcon,
  folderIcon,
  workspace,
  openWorkspace,
  closeWorkspace,
  refreshWorkspace,
  restoreWorkspace,
  takeStartupWorkspace,
  initWorkspace,
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

describe('fileIcon', () => {
  it.each([
    ['notes.md', 'file-code'],
    ['README.MARKDOWN', 'file-code'],
    ['image.png', 'file-text'],
    ['data.json', 'file-text'],
    ['Makefile', 'file-text'],
  ])('%s -> %s', (name, expected) => {
    expect(fileIcon(name)).toBe(expected)
  })
})

describe('folderIcon', () => {
  it('is folder-open when expanded', () => {
    expect(folderIcon(true)).toBe('folder-open')
  })

  it('is folder when collapsed', () => {
    expect(folderIcon(false)).toBe('folder')
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

  it('with a folder already open, routes to pick_folder_new_instance and adopts nothing', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    invoke.mockResolvedValue(true) // user picked a dir; a new process now owns it
    await openWorkspace()
    expect(invoke).toHaveBeenCalledWith('pick_folder_new_instance')
    expect(invoke).not.toHaveBeenCalledWith('open_workspace_dialog')
    // The current instance keeps its own workspace untouched.
    expect(get(workspace).root).toBe('/ws/notes')
    expect(get(workspaceName)).toBe('notes')
  })

  it('reports an error when spawning the new instance fails', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    invoke.mockRejectedValue('spawn failed')
    await openWorkspace()
    expect(get(errorMessage)).toContain('workspace')
    expect(get(workspace).root).toBe('/ws/notes')
  })
})

describe('closeWorkspace', () => {
  it('deletes the restore pointer (passing the owned root) and resets the store + breadcrumb', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    invoke.mockResolvedValue(undefined)
    await closeWorkspace()
    // The root rides along so Rust can prove this instance owns the pointer
    // before deleting the file shared by every running instance.
    expect(invoke).toHaveBeenCalledWith('close_workspace', { root: '/ws/notes' })
    expect(get(workspace)).toEqual({ root: null, tree: null })
    expect(get(workspaceName)).toBeNull()
  })

  it('still closes locally (and reports) when deleting the pointer fails', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    invoke.mockRejectedValue('io error')
    await closeWorkspace()
    expect(get(errorMessage)).toContain('close')
    expect(get(workspace)).toEqual({ root: null, tree: null })
    expect(get(workspaceName)).toBeNull()
  })

  it('with no folder open, skips the invoke entirely and just resets the store', async () => {
    await closeWorkspace()
    expect(invoke).not.toHaveBeenCalled()
    expect(get(workspace)).toEqual({ root: null, tree: null })
  })
})

describe('takeStartupWorkspace', () => {
  it('adopts a CLI-provided workspace and reports the restore is suppressed', async () => {
    invoke.mockResolvedValue({
      workspace: { root: '/ws/cli', tree: tree('cli') },
      suppress_restore: true,
    })
    await expect(takeStartupWorkspace()).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith('take_startup_workspace')
    expect(get(workspace).root).toBe('/ws/cli')
    expect(get(workspaceName)).toBe('cli')
  })

  it('reports false (restore allowed) on a cold launch with nothing pending', async () => {
    invoke.mockResolvedValue({ workspace: null, suppress_restore: false })
    await expect(takeStartupWorkspace()).resolves.toBe(false)
    expect(get(workspace).root).toBeNull()
  })

  it('a handed-off launch whose dir vanished still suppresses the restore (folder-less start)', async () => {
    // The tri-state that stops a child adopting its SPAWNER's folder: no
    // workspace to adopt, but the launch WAS a hand-off.
    invoke.mockResolvedValue({ workspace: null, suppress_restore: true })
    await expect(takeStartupWorkspace()).resolves.toBe(true)
    expect(get(workspace).root).toBeNull()
    expect(get(workspaceName)).toBeNull()
  })

  it('swallows errors and reports false (caller falls back to restore, like a cold launch)', async () => {
    invoke.mockRejectedValue('nope')
    await expect(takeStartupWorkspace()).resolves.toBe(false)
    expect(get(workspace).root).toBeNull()
    expect(get(errorMessage)).toBeNull()
  })
})

describe('initWorkspace startup ordering', () => {
  it('a startup workspace wins and SKIPS restore_workspace entirely', async () => {
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'take_startup_workspace'
        ? { workspace: { root: '/ws/cli', tree: tree('cli') }, suppress_restore: true }
        : null,
    )
    const teardown = await initWorkspace()
    await vi.waitFor(() => expect(get(workspace).root).toBe('/ws/cli'))
    expect(invoke).not.toHaveBeenCalledWith('restore_workspace')
    teardown()
  })

  it('a suppressed hand-off with no adoptable workspace stays folder-less (no restore)', async () => {
    // open_file_new_instance children (files-only argv) and --workspace dirs
    // that vanished both land here: restore would adopt the spawner's folder.
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'take_startup_workspace' ? { workspace: null, suppress_restore: true } : null,
    )
    const teardown = await initWorkspace()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('take_startup_workspace'))
    // Let the takeStartupWorkspace().then(...) chain settle before asserting
    // the restore branch was genuinely skipped, not merely not-yet-reached.
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).not.toHaveBeenCalledWith('restore_workspace')
    expect(get(workspace).root).toBeNull()
    teardown()
  })

  it('falls back to restore_workspace on a cold launch with nothing pending', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_startup_workspace') return { workspace: null, suppress_restore: false }
      return cmd === 'restore_workspace' ? { root: '/ws/prev', tree: tree('prev') } : null
    })
    const teardown = await initWorkspace()
    await vi.waitFor(() => expect(get(workspace).root).toBe('/ws/prev'))
    expect(invoke).toHaveBeenCalledWith('take_startup_workspace')
    expect(invoke).toHaveBeenCalledWith('restore_workspace')
    teardown()
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
