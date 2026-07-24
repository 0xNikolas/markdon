import { describe, it, expect, vi, beforeEach } from 'vitest'

// Drive the facade against a local invoke spy (the same shape as the shared
// tauriMocks one). Each assertion pins the exact command string AND the exact
// arg object the facade forwards — this is the drift lock: it fails the moment
// a wrapper renames a command, reshapes an arg, or (for the zero-arg commands)
// starts passing a stray second argument.
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import * as ipc from './ipc'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('ipc facade — command name + arg forwarding', () => {
  // commands.rs
  it('readFile', async () => {
    await ipc.readFile('/a.md')
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/a.md' })
  })
  it('writeFile', async () => {
    await ipc.writeFile('/a.md', 'body')
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/a.md', contents: 'body' })
  })
  it('resolveImageAsset forwards camelCase docPath + rel', async () => {
    await ipc.resolveImageAsset('/doc.md', 'sub/pic.png')
    expect(invoke).toHaveBeenCalledWith('resolve_image_asset', {
      docPath: '/doc.md',
      rel: 'sub/pic.png',
    })
  })
  it('revealPath', async () => {
    await ipc.revealPath('/a.md')
    expect(invoke).toHaveBeenCalledWith('reveal_path', { path: '/a.md' })
  })

  // lib.rs
  it('setReadonlyMenuState', async () => {
    await ipc.setReadonlyMenuState(true)
    expect(invoke).toHaveBeenCalledWith('set_readonly_menu_state', { checked: true })
  })

  // windows.rs
  it('openDocumentWindow', async () => {
    await ipc.openDocumentWindow('/a.md', true)
    expect(invoke).toHaveBeenCalledWith('open_document_window', { path: '/a.md', readonly: true })
  })
  it('openFileNewInstance', async () => {
    await ipc.openFileNewInstance('/a.md')
    expect(invoke).toHaveBeenCalledWith('open_file_new_instance', { path: '/a.md' })
  })

  // watcher.rs
  it('watchFile', async () => {
    await ipc.watchFile('/a.md')
    expect(invoke).toHaveBeenCalledWith('watch_file', { path: '/a.md' })
  })
  it('watchWorkspace', async () => {
    await ipc.watchWorkspace('/root')
    expect(invoke).toHaveBeenCalledWith('watch_workspace', { root: '/root' })
  })

  // dialogs.rs
  it('saveFileDialog with filters forwards both keys', async () => {
    const filters = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
    await ipc.saveFileDialog('/a.md', filters)
    expect(invoke).toHaveBeenCalledWith('save_file_dialog', { defaultPath: '/a.md', filters })
  })
  it('saveFileDialog without filters matches the bare-defaultPath shape', async () => {
    await ipc.saveFileDialog('untitled.md')
    // filters is undefined here; toHaveBeenCalledWith ignores undefined props, so
    // this is equivalence-equal to the old { defaultPath } call sites (and JSON
    // drops the undefined key on the wire) — the zero-behavior guarantee.
    expect(invoke).toHaveBeenCalledWith('save_file_dialog', { defaultPath: 'untitled.md' })
  })

  // workspace.rs
  it('closeWorkspace', async () => {
    await ipc.closeWorkspace('/root')
    expect(invoke).toHaveBeenCalledWith('close_workspace', { root: '/root' })
  })
  it('openRecentWorkspace forwards root + camelCase currentRoot', async () => {
    await ipc.openRecentWorkspace('/root', '/current')
    expect(invoke).toHaveBeenCalledWith('open_recent_workspace', {
      root: '/root',
      currentRoot: '/current',
    })
  })
  it('openRecentWorkspace forwards a null currentRoot', async () => {
    await ipc.openRecentWorkspace('/root', null)
    expect(invoke).toHaveBeenCalledWith('open_recent_workspace', { root: '/root', currentRoot: null })
  })
  it('saveWorkspaceUi forwards the full {root,tabs,preview,active} shape', async () => {
    await ipc.saveWorkspaceUi('/root', ['/a.md', '/b.md'], '/p.md', '/a.md')
    expect(invoke).toHaveBeenCalledWith('save_workspace_ui', {
      root: '/root',
      tabs: ['/a.md', '/b.md'],
      preview: '/p.md',
      active: '/a.md',
    })
  })
  it('loadWorkspaceUi', async () => {
    await ipc.loadWorkspaceUi('/root')
    expect(invoke).toHaveBeenCalledWith('load_workspace_ui', { root: '/root' })
  })
  it('listWorkspace', async () => {
    await ipc.listWorkspace('/root')
    expect(invoke).toHaveBeenCalledWith('list_workspace', { root: '/root' })
  })

  // fileops.rs
  it('createFile', async () => {
    await ipc.createFile('/dir', 'a.md')
    expect(invoke).toHaveBeenCalledWith('create_file', { dir: '/dir', name: 'a.md' })
  })
  it('createFolder', async () => {
    await ipc.createFolder('/dir', 'sub')
    expect(invoke).toHaveBeenCalledWith('create_folder', { dir: '/dir', name: 'sub' })
  })
  it('renameEntry forwards camelCase newName', async () => {
    await ipc.renameEntry('/a.md', 'b.md')
    expect(invoke).toHaveBeenCalledWith('rename_entry', { path: '/a.md', newName: 'b.md' })
  })
  it('moveEntry forwards camelCase destDir', async () => {
    await ipc.moveEntry('/a.md', '/dst')
    expect(invoke).toHaveBeenCalledWith('move_entry', { src: '/a.md', destDir: '/dst' })
  })
  it('copyEntry forwards camelCase destDir', async () => {
    await ipc.copyEntry('/a.md', '/dst')
    expect(invoke).toHaveBeenCalledWith('copy_entry', { src: '/a.md', destDir: '/dst' })
  })
  it('duplicateEntry', async () => {
    await ipc.duplicateEntry('/a.md')
    expect(invoke).toHaveBeenCalledWith('duplicate_entry', { path: '/a.md' })
  })
  it('deleteEntries', async () => {
    await ipc.deleteEntries(['/a.md', '/b.md'])
    expect(invoke).toHaveBeenCalledWith('delete_entries', { paths: ['/a.md', '/b.md'] })
  })
  it('savePastedImage forwards camelCase docPath + dataB64 + ext', async () => {
    await ipc.savePastedImage('/doc.md', 'QUJD', 'png')
    expect(invoke).toHaveBeenCalledWith('save_pasted_image', {
      docPath: '/doc.md',
      dataB64: 'QUJD',
      ext: 'png',
    })
  })

  // history.rs
  it('recordHistory', async () => {
    await ipc.recordHistory('/a.md', 'save')
    expect(invoke).toHaveBeenCalledWith('record_history', { path: '/a.md', trigger: 'save' })
  })
  it('listHistory', async () => {
    await ipc.listHistory('/a.md')
    expect(invoke).toHaveBeenCalledWith('list_history', { path: '/a.md' })
  })
  it('readHistoryVersion', async () => {
    await ipc.readHistoryVersion('/a.md', 'v1')
    expect(invoke).toHaveBeenCalledWith('read_history_version', { path: '/a.md', id: 'v1' })
  })

  // prefs.rs
  it('savePrefs forwards { json }', async () => {
    await ipc.savePrefs('{"a":1}')
    expect(invoke).toHaveBeenCalledWith('save_prefs', { json: '{"a":1}' })
  })

  // pdf.rs
  it('exportPdf forwards { html, title }', async () => {
    await ipc.exportPdf('<h1>x</h1>', 'Doc')
    expect(invoke).toHaveBeenCalledWith('export_pdf', { html: '<h1>x</h1>', title: 'Doc' })
  })
})

describe('ipc facade — zero-arg commands call invoke with NO second argument', () => {
  // The mock records call args verbatim; a stray {} or undefined 2nd arg here
  // would make the shared spy see 2 args and break the ~12 existing
  // `toHaveBeenCalledWith('cmd')` single-arg assertions across the suite.
  const zeroArg: [string, () => Promise<unknown>][] = [
    ['reveal_log_file', ipc.revealLogFile],
    ['take_opened_files', ipc.takeOpenedFiles],
    ['take_window_file', ipc.takeWindowFile],
    ['unwatch', ipc.unwatch],
    ['unwatch_workspace', ipc.unwatchWorkspace],
    ['open_file_dialog', ipc.openFileDialog],
    ['open_workspace_dialog', ipc.openWorkspaceDialog],
    ['pick_folder_new_instance', ipc.pickFolderNewInstance],
    ['restore_workspace', ipc.restoreWorkspace],
    ['take_startup_workspace', ipc.takeStartupWorkspace],
    ['list_recent_workspaces', ipc.listRecentWorkspaces],
    ['load_prefs', ipc.loadPrefs],
    ['cli_status', ipc.cliStatus],
    ['install_cli', ipc.installCli],
    ['uninstall_cli', ipc.uninstallCli],
  ]

  for (const [name, fn] of zeroArg) {
    it(`${name} is called with a single argument`, async () => {
      await fn()
      expect(invoke).toHaveBeenCalledWith(name)
      expect(invoke.mock.calls[0]).toHaveLength(1)
    })
  }
})
