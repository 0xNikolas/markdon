import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
// window is imported by initWorkspace (onFocusChanged) and windowing.ts's
// currentLabel (the label feeds listenScoped's target filter); stub both.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}))
// Capture listenScoped registrations so tests can deliver 'workspace:changed'.
const { eventHandlers } = vi.hoisted(() => ({
  eventHandlers: new Map<string, ((e: { payload: unknown }) => void)[]>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const list = eventHandlers.get(event) ?? []
    list.push(handler)
    eventHandlers.set(event, list)
    return () => {
      const arr = eventHandlers.get(event) ?? []
      const i = arr.indexOf(handler)
      if (i >= 0) arr.splice(i, 1)
    }
  }),
}))

/** Deliver a Tauri event to every captured listener (listenScoped included). */
function emitEvent(event: string, payload: unknown): void {
  for (const handler of eventHandlers.get(event) ?? []) handler({ payload })
}

import {
  isMarkdownFile,
  isImageFile,
  fileIcon,
  folderIcon,
  workspace,
  openWorkspace,
  openRecentWorkspace,
  closeWorkspace,
  refreshWorkspace,
  restoreWorkspace,
  takeStartupWorkspace,
  initWorkspace,
  listRecentWorkspaces,
  recentWorkspaceDisplay,
  stampTabState,
  flushTabWrite,
  resetTabRecording,
  type WorkspaceDir,
} from './workspace'
import { openList, previewPath } from './openList'
import { doc, docWith } from './doc'
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
  eventHandlers.clear()
  workspace.set({ root: null, tree: null })
  workspaceName.set(null)
  errorMessage.set(null)
  doc.set(docWith())
  openList.set([])
  previewPath.set(null)
  resetTabRecording()
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

describe('isImageFile', () => {
  it.each([
    ['logo.png', true],
    ['photo.jpg', true],
    ['photo.jpeg', true],
    ['anim.gif', true],
    ['pic.webp', true],
    ['icon.svg', true],
    ['LOGO.PNG', true],
    ['Photo.JPeG', true],
    ['a.md', false],
    ['readme.txt', false],
    ['data.json', false],
    ['a.png.bak', false],
    ['noext', false],
  ])('%s -> %s', (name, expected) => {
    expect(isImageFile(name)).toBe(expected)
  })
})

describe('fileIcon', () => {
  it.each([
    ['notes.md', 'file-code'],
    ['README.MARKDOWN', 'file-code'],
    ['image.png', 'image'],
    ['icon.svg', 'image'],
    ['Photo.JPEG', 'image'],
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

describe('openRecentWorkspace', () => {
  it('is a no-op when the root is already open here (no invoke)', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    await openRecentWorkspace('/ws/notes')
    expect(invoke).not.toHaveBeenCalled()
    expect(get(workspace).root).toBe('/ws/notes')
  })

  it('adopts in place when folder-less (store + breadcrumb set)', async () => {
    invoke.mockResolvedValue({ root: '/ws/recent', tree: tree('recent') })
    await openRecentWorkspace('/ws/recent')
    expect(invoke).toHaveBeenCalledWith('open_recent_workspace', {
      root: '/ws/recent',
      currentRoot: null,
    })
    expect(get(workspace).root).toBe('/ws/recent')
    expect(get(workspaceName)).toBe('recent')
  })

  it('with a folder already open, passes currentRoot and adopts nothing (null = spawned)', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    invoke.mockResolvedValue(null) // Rust spawned a new instance for the root
    await openRecentWorkspace('/ws/other')
    expect(invoke).toHaveBeenCalledWith('open_recent_workspace', {
      root: '/ws/other',
      currentRoot: '/ws/notes',
    })
    // This instance keeps its own workspace untouched.
    expect(get(workspace).root).toBe('/ws/notes')
    expect(get(workspaceName)).toBe('notes')
  })

  it('banners a rejection (vanished folder) and leaves the store untouched', async () => {
    invoke.mockRejectedValue('workspace root is not a directory')
    await openRecentWorkspace('/ws/gone')
    expect(get(errorMessage)).toContain('reopen')
    expect(get(workspace).root).toBeNull()
  })
})

describe('listRecentWorkspaces', () => {
  it('returns the Rust MRU verbatim', async () => {
    invoke.mockResolvedValue(['/ws/b', '/ws/a'])
    await expect(listRecentWorkspaces()).resolves.toEqual(['/ws/b', '/ws/a'])
    expect(invoke).toHaveBeenCalledWith('list_recent_workspaces')
  })

  it('degrades to an empty list on failure — never a banner', async () => {
    invoke.mockRejectedValue('ipc down')
    await expect(listRecentWorkspaces()).resolves.toEqual([])
    expect(get(errorMessage)).toBeNull()
  })
})

describe('recentWorkspaceDisplay', () => {
  it('splits a root into basename and parent, abbreviating home to ~', () => {
    expect(recentWorkspaceDisplay('/Users/me/notes', '/Users/me')).toEqual({
      name: 'notes',
      parent: '~',
    })
    expect(recentWorkspaceDisplay('/Users/me/dev/proj', '/Users/me')).toEqual({
      name: 'proj',
      parent: '~/dev',
    })
  })

  it('keeps the raw parent outside home or with no home known', () => {
    expect(recentWorkspaceDisplay('/srv/data/ws', '/Users/me')).toEqual({
      name: 'ws',
      parent: '/srv/data',
    })
    expect(recentWorkspaceDisplay('/srv/data/ws', null)).toEqual({
      name: 'ws',
      parent: '/srv/data',
    })
  })

  it('does not abbreviate a sibling that merely shares home as a string prefix', () => {
    // Mirrors menu.rs recent_label's segment-safe rule.
    expect(recentWorkspaceDisplay('/Users/melon/ws', '/Users/me')).toEqual({
      name: 'ws',
      parent: '/Users/melon',
    })
  })

  it('falls back legibly on degenerate roots', () => {
    expect(recentWorkspaceDisplay('/', '/Users/me')).toEqual({ name: '/', parent: '' })
    expect(recentWorkspaceDisplay('/top', null)).toEqual({ name: 'top', parent: '/' })
    expect(recentWorkspaceDisplay('/Users/me/notes/', '/Users/me')).toEqual({
      name: 'notes',
      parent: '~',
    })
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

describe('initWorkspace workspace watcher', () => {
  /** Cold launch with nothing to restore: watcher wiring is the only actor. */
  const coldMock = () =>
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'take_startup_workspace' ? { workspace: null, suppress_restore: true } : null,
    )

  const watchCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'watch_workspace')
  const listCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'list_workspace')

  it('installs the Rust watcher when a root is adopted', async () => {
    coldMock()
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    expect(invoke).toHaveBeenCalledWith('watch_workspace', { root: '/ws/a' })
    teardown()
  })

  it('re-points the watcher once per root switch, not per refresh', async () => {
    coldMock()
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    workspace.set({ root: '/ws/b', tree: tree('b') })
    // A plain refresh re-adopts the SAME root (fresh tree object): no re-invoke.
    workspace.set({ root: '/ws/b', tree: tree('b') })
    expect(watchCalls().map(([, args]) => args)).toEqual([{ root: '/ws/a' }, { root: '/ws/b' }])
    teardown()
  })

  it('drops the watcher when the folder closes (root -> null)', async () => {
    coldMock()
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    workspace.set({ root: null, tree: null })
    expect(invoke).toHaveBeenCalledWith('unwatch_workspace')
    teardown()
  })

  it('one workspace:changed delivery = one list_workspace; bursts in flight are dropped', async () => {
    let resolveList: ((v: unknown) => void) | undefined
    invoke.mockImplementation((cmd: unknown) => {
      if (cmd === 'list_workspace')
        return new Promise((r) => {
          resolveList = r
        })
      return Promise.resolve(
        cmd === 'take_startup_workspace' ? { workspace: null, suppress_restore: true } : null,
      )
    })
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })

    emitEvent('workspace:changed', { target: 'main' })
    // Second delivery while the first walk is unresolved: dropped, not queued.
    emitEvent('workspace:changed', { target: 'main' })
    expect(listCalls()).toHaveLength(1)

    resolveList?.({ root: '/ws/a', tree: tree('a') })
    await new Promise((r) => setTimeout(r, 0))
    // With the walk settled, the next burst refreshes again.
    emitEvent('workspace:changed', { target: 'main' })
    expect(listCalls()).toHaveLength(2)
    teardown()
  })

  it("drops a delivery targeted at another window's label", async () => {
    coldMock()
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    emitEvent('workspace:changed', { target: 'doc-2' })
    expect(listCalls()).toHaveLength(0)
    teardown()
  })

  it('fails open when the watch cannot be installed: logWarn territory, no banner', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'watch_workspace') throw 'inotify exhausted'
      return cmd === 'take_startup_workspace' ? { workspace: null, suppress_restore: true } : null
    })
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    await new Promise((r) => setTimeout(r, 0))
    expect(get(errorMessage)).toBeNull()
    expect(get(workspace).root).toBe('/ws/a')
    teardown()
  })

  it('teardown stops the Rust watcher and unhooks event + store subscriptions', async () => {
    coldMock()
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/a', tree: tree('a') })
    teardown()
    expect(invoke).toHaveBeenCalledWith('unwatch_workspace')
    // Listener removed: a later delivery refreshes nothing.
    emitEvent('workspace:changed', { target: 'main' })
    expect(listCalls()).toHaveLength(0)
    // Store subscription removed: a new root no longer re-points the watcher.
    const watched = watchCalls().length
    workspace.set({ root: '/ws/b', tree: tree('b') })
    expect(watchCalls()).toHaveLength(watched)
  })
})

describe('strip write-through', () => {
  const uiCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'save_workspace_ui')
  const uiArgs = () => uiCalls().map(([, args]) => args)

  /** Cold init (nothing to restore) that adopts `root`, so the openList /
      previewPath / doc subscriptions are wired against an open workspace. The
      write-through is debounced, so tests force the pending write with
      flushTabWrite() (or a teardown, which flushes) rather than a real timer. */
  async function initWithRoot(root = '/ws/notes'): Promise<() => void> {
    invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'take_startup_workspace') return { workspace: null, suppress_restore: true }
      if (cmd === 'list_workspace') return { root: (args as { root: string }).root, tree: tree('a') }
      return undefined
    })
    const teardown = await initWorkspace()
    workspace.set({ root, tree: tree('notes') })
    return teardown
  }

  it('persists the whole strip inside-root, suppressing an identical re-write', async () => {
    const teardown = await initWithRoot()
    openList.set(['/ws/notes/a.md'])
    previewPath.set('/ws/notes/p.md')
    doc.set(docWith({ path: '/ws/notes/a.md' }))
    flushTabWrite()
    expect(uiArgs()).toEqual([
      { root: '/ws/notes', tabs: ['/ws/notes/a.md'], preview: '/ws/notes/p.md', active: '/ws/notes/a.md' },
    ])
    // Re-setting the stores to the SAME strip schedules a write the serialized
    // guard then suppresses.
    openList.set(['/ws/notes/a.md'])
    flushTabWrite()
    expect(uiCalls()).toHaveLength(1)
    teardown()
  })

  it('writes again when the strip actually changes', async () => {
    const teardown = await initWithRoot()
    openList.set(['/ws/notes/a.md'])
    flushTabWrite()
    openList.set(['/ws/notes/b.md', '/ws/notes/a.md'])
    flushTabWrite()
    expect(uiArgs()).toEqual([
      { root: '/ws/notes', tabs: ['/ws/notes/a.md'], preview: null, active: null },
      { root: '/ws/notes', tabs: ['/ws/notes/b.md', '/ws/notes/a.md'], preview: null, active: null },
    ])
    teardown()
  })

  it('excludes paths outside the root from tabs, preview, and active alike', async () => {
    const teardown = await initWithRoot()
    openList.set(['/ws/notes/a.md', '/elsewhere/x.md', '/ws/notes-evil/y.md'])
    previewPath.set('/outside/p.md')
    doc.set(docWith({ path: '/elsewhere/standalone.md' })) // a standalone open
    flushTabWrite()
    expect(uiArgs()).toEqual([
      { root: '/ws/notes', tabs: ['/ws/notes/a.md'], preview: null, active: null },
    ])
    teardown()
  })

  it('records nothing while no folder is open', async () => {
    const teardown = await initWithRoot()
    workspace.set({ root: null, tree: null })
    openList.set(['/x.md'])
    doc.set(docWith({ path: '/x.md' }))
    flushTabWrite()
    expect(uiCalls()).toHaveLength(0)
    teardown()
  })

  it('coalesces a burst of strip changes into ONE debounced write', async () => {
    const teardown = await initWithRoot()
    // A multi-file drain shape: three prepends in one tick.
    openList.set(['/ws/notes/a.md'])
    openList.set(['/ws/notes/b.md', '/ws/notes/a.md'])
    openList.set(['/ws/notes/c.md', '/ws/notes/b.md', '/ws/notes/a.md'])
    flushTabWrite()
    expect(uiCalls()).toHaveLength(1) // three set()s, one write
    expect((uiArgs()[0] as { tabs: string[] }).tabs).toEqual([
      '/ws/notes/c.md',
      '/ws/notes/b.md',
      '/ws/notes/a.md',
    ])
    teardown()
  })

  it('window-close (teardown) flushes the final, still-pending tab set', async () => {
    const teardown = await initWithRoot()
    openList.set(['/ws/notes/a.md'])
    doc.set(docWith({ path: '/ws/notes/a.md' }))
    // The debounce has NOT fired (no timer advance): the write is still pending.
    expect(uiCalls()).toHaveLength(0)
    teardown() // teardown flushes so the last strip isn't lost on window close
    expect(uiArgs()).toEqual([
      { root: '/ws/notes', tabs: ['/ws/notes/a.md'], preview: null, active: '/ws/notes/a.md' },
    ])
  })

  it('a pre-stamped restore does NOT echo a save back (no self-clobber)', async () => {
    const teardown = await initWithRoot()
    const state = {
      tabs: ['/ws/notes/a.md', '/ws/notes/b.md'],
      preview: '/ws/notes/p.md',
      active: '/ws/notes/a.md',
    }
    // Pre-stamp, THEN drive the stores exactly as restoreTabs would.
    stampTabState('/ws/notes', state)
    openList.set(state.tabs)
    previewPath.set(state.preview)
    doc.set(docWith({ path: state.active }))
    flushTabWrite()
    expect(uiCalls()).toHaveLength(0)
    teardown()
  })

  it('persists PATHS only — a dirty buffer is never serialized (edits can’t be lost)', async () => {
    const teardown = await initWithRoot()
    openList.set(['/ws/notes/a.md'])
    doc.set(docWith({ path: '/ws/notes/a.md', content: 'unsaved-secret-edits', savedContent: 'clean' }))
    flushTabWrite()
    expect(uiArgs()).toEqual([
      { root: '/ws/notes', tabs: ['/ws/notes/a.md'], preview: null, active: '/ws/notes/a.md' },
    ])
    expect(JSON.stringify(uiArgs()[0])).not.toContain('unsaved-secret-edits')
    teardown()
  })

  it('a failed write is logWarn territory — never a banner', async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'take_startup_workspace') return { workspace: null, suppress_restore: true }
      if (cmd === 'save_workspace_ui') throw 'disk full'
      return undefined
    })
    const teardown = await initWorkspace()
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    openList.set(['/ws/notes/a.md'])
    flushTabWrite()
    await new Promise((r) => setTimeout(r, 0))
    expect(get(errorMessage)).toBeNull()
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

  it('drops a walk that resolves after Close Folder (no workspace resurrection)', async () => {
    workspace.set({ root: '/ws/notes', tree: tree('notes') })
    workspaceName.set('notes')
    let resolveList!: (v: unknown) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'list_workspace'
        ? new Promise((r) => {
            resolveList = r
          })
        : Promise.resolve(undefined),
    )
    const p = refreshWorkspace()
    // User clicks Close Folder while the walk is in flight.
    await closeWorkspace()
    resolveList({ root: '/ws/notes', tree: tree('notes') })
    await p
    // The stale walk must not re-adopt the closed workspace (which would also
    // re-install the Rust watcher via the root-transition subscription).
    expect(get(workspace)).toEqual({ root: null, tree: null })
    expect(get(workspaceName)).toBeNull()
  })

  it('drops a walk that resolves after a switch to a different root', async () => {
    workspace.set({ root: '/ws/a', tree: tree('a') })
    let resolveList!: (v: unknown) => void
    invoke.mockImplementation((cmd: unknown) =>
      cmd === 'list_workspace'
        ? new Promise((r) => {
            resolveList = r
          })
        : Promise.resolve(undefined),
    )
    const p = refreshWorkspace()
    workspace.set({ root: '/ws/b', tree: tree('b') }) // root switched mid-walk
    resolveList({ root: '/ws/a', tree: tree('a') })
    await p
    expect(get(workspace).root).toBe('/ws/b')
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
