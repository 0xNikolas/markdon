// The single typed boundary over Tauri's `invoke`. Every backend command the
// webview calls has exactly one thin wrapper here, and the command-name string
// lives ONLY in this file — a rename or a typo becomes a compile error in one
// place instead of a silent runtime reject at a scattered call site. Each
// wrapper carries the command's arg + return types (mirroring the Rust structs
// in src-tauri), so a drifted payload shape is a `bun run check` failure rather
// than a latent bug. This is a pure pass-through: it forwards the same command
// name and the same arg object the call sites always sent, so the test-mock
// interception (~90 `invoke` spy assertions) and the real IPC wire are both
// byte-for-byte unchanged.
//
// Arg keys are camelCase — Tauri converts them to the Rust command's snake_case
// params (newName -> new_name, etc.). RETURN struct fields stay snake_case
// because Rust serializes them verbatim (no serde renames on any IPC struct),
// which is why the wire types below keep on_path / suppress_restore / readonly.
//
// This is the ONLY module that imports `invoke` from @tauri-apps/api/core for
// the request/response commands. (logging.ts keeps its own `invoke` for the
// separate fire-and-forget `.catch(logWarn)` idiom — see fireAndForget there.)
//
// The domain-type imports below are `import type` and are erased at compile
// time, so there is no runtime import cycle even though workspace/history/
// cliInstall/files import this module at runtime.
import { invoke } from '@tauri-apps/api/core'
import type { Workspace, WorkspaceTabs } from './workspace'
import type { HistoryEntry } from './history'
import type { CliStatus } from './cliInstall'
import type { OpenedEntry } from './files'

// --- wire types owned here (previously anonymous inline or private) ---------

/** A file the Open dialog loaded: its path and freshly-read content. */
export interface OpenedFile {
  path: string
  content: string
}

/** A per-window file hand-off (mirrors Rust `windows.rs` AssignedFile). */
export interface AssignedFile {
  path: string
  readonly: boolean
}

/** The startup workspace hand-off (mirrors Rust `workspace.rs` StartupHandoff). */
export interface StartupHandoff {
  workspace: Workspace | null
  suppress_restore: boolean
}

/** A save-dialog file-type filter (mirrors Rust `dialogs.rs` FileFilter). */
export interface FileFilter {
  name: string
  extensions: string[]
}

// --- commands.rs ------------------------------------------------------------

export const readFile = (path: string): Promise<string> => invoke('read_file', { path })

export const writeFile = (path: string, contents: string): Promise<void> =>
  invoke('write_file', { path, contents })

export const resolveImageAsset = (docPath: string, rel: string): Promise<string> =>
  invoke('resolve_image_asset', { docPath, rel })

export const revealLogFile = (): Promise<void> => invoke('reveal_log_file')

export const revealPath = (path: string): Promise<void> => invoke('reveal_path', { path })

// --- lib.rs -----------------------------------------------------------------

export const takeOpenedFiles = (): Promise<OpenedEntry[]> => invoke('take_opened_files')

export const setReadonlyMenuState = (checked: boolean): Promise<void> =>
  invoke('set_readonly_menu_state', { checked })

// --- windows.rs -------------------------------------------------------------

export const takeWindowFile = (): Promise<AssignedFile | null> => invoke('take_window_file')

export const openDocumentWindow = (path: string, readonly: boolean): Promise<void> =>
  invoke('open_document_window', { path, readonly })

export const openFileNewInstance = (path: string): Promise<void> =>
  invoke('open_file_new_instance', { path })

// --- watcher.rs -------------------------------------------------------------

export const watchFile = (path: string): Promise<void> => invoke('watch_file', { path })

export const unwatch = (): Promise<void> => invoke('unwatch')

export const watchWorkspace = (root: string): Promise<void> => invoke('watch_workspace', { root })

export const unwatchWorkspace = (): Promise<void> => invoke('unwatch_workspace')

// --- dialogs.rs -------------------------------------------------------------

export const openFileDialog = (): Promise<OpenedFile | null> => invoke('open_file_dialog')

export const saveFileDialog = (defaultPath: string, filters?: FileFilter[]): Promise<string | null> =>
  invoke('save_file_dialog', { defaultPath, filters })

export const openWorkspaceDialog = (): Promise<Workspace | null> => invoke('open_workspace_dialog')

export const pickFolderNewInstance = (): Promise<boolean> => invoke('pick_folder_new_instance')

// --- workspace.rs -----------------------------------------------------------

export const listWorkspace = (root: string): Promise<Workspace> => invoke('list_workspace', { root })

export const restoreWorkspace = (): Promise<Workspace | null> => invoke('restore_workspace')

export const closeWorkspace = (root: string): Promise<void> => invoke('close_workspace', { root })

export const openRecentWorkspace = (
  root: string,
  currentRoot: string | null,
): Promise<Workspace | null> => invoke('open_recent_workspace', { root, currentRoot })

export const takeStartupWorkspace = (): Promise<StartupHandoff> => invoke('take_startup_workspace')

export const listRecentWorkspaces = (): Promise<string[]> => invoke('list_recent_workspaces')

export const saveWorkspaceUi = (
  root: string,
  tabs: string[],
  preview: string | null,
  active: string | null,
): Promise<void> => invoke('save_workspace_ui', { root, tabs, preview, active })

export const loadWorkspaceUi = (root: string): Promise<WorkspaceTabs | null> =>
  invoke('load_workspace_ui', { root })

// --- fileops.rs -------------------------------------------------------------

export const createFile = (dir: string, name: string): Promise<string> =>
  invoke('create_file', { dir, name })

export const createFolder = (dir: string, name: string): Promise<string> =>
  invoke('create_folder', { dir, name })

export const renameEntry = (path: string, newName: string): Promise<string> =>
  invoke('rename_entry', { path, newName })

export const moveEntry = (src: string, destDir: string): Promise<string> =>
  invoke('move_entry', { src, destDir })

export const copyEntry = (src: string, destDir: string): Promise<string> =>
  invoke('copy_entry', { src, destDir })

export const duplicateEntry = (path: string): Promise<string> =>
  invoke('duplicate_entry', { path })

export const deleteEntries = (paths: string[]): Promise<void> =>
  invoke('delete_entries', { paths })

export const savePastedImage = (docPath: string, dataB64: string, ext: string): Promise<string> =>
  invoke('save_pasted_image', { docPath, dataB64, ext })

// --- history.rs -------------------------------------------------------------

export const recordHistory = (path: string, trigger: HistoryEntry['trigger']): Promise<void> =>
  invoke('record_history', { path, trigger })

export const listHistory = (path: string): Promise<HistoryEntry[]> =>
  invoke('list_history', { path })

export const readHistoryVersion = (path: string, id: string): Promise<string> =>
  invoke('read_history_version', { path, id })

// --- prefs.rs ---------------------------------------------------------------

export const loadPrefs = (): Promise<string | null> => invoke('load_prefs')

export const savePrefs = (json: string): Promise<void> => invoke('save_prefs', { json })

// --- cli_install.rs ---------------------------------------------------------

export const cliStatus = (): Promise<CliStatus> => invoke('cli_status')

export const installCli = (): Promise<CliStatus> => invoke('install_cli')

export const uninstallCli = (): Promise<CliStatus> => invoke('uninstall_cli')

// --- pdf.rs -----------------------------------------------------------------

export const exportPdf = (html: string, title: string): Promise<void> =>
  invoke('export_pdf', { html, title })
