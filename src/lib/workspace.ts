import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { get, writable, type Writable } from 'svelte/store'
import { doc } from './doc'
import { reportError } from './errors'
import { workspaceName } from './ui'

/** A file leaf in the workspace tree (mirrors Rust `WorkspaceFile`). */
export interface WorkspaceFile {
  name: string
  path: string
}

/** A directory node in the workspace tree (mirrors Rust `WorkspaceDir`). */
export interface WorkspaceDir {
  name: string
  path: string
  dirs: WorkspaceDir[]
  files: WorkspaceFile[]
  /** True when the depth/entry budget was hit somewhere at or below this node. */
  truncated: boolean
}

/** Full workspace payload from Rust (`open_workspace_dialog` / restore / list). */
export interface Workspace {
  root: string
  tree: WorkspaceDir
}

export interface WorkspaceState {
  root: string | null
  tree: WorkspaceDir | null
}

/** The open workspace folder and its file tree. `root === null` hides the sidebar. */
export const workspace: Writable<WorkspaceState> = writable({ root: null, tree: null })

/** True for files the editor can open — the only rows rendered as buttons. */
export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}

/**
 * Lucide icon name for a sidebar file row. Markdown files (the only openable
 * rows) get `file-code`, matching the design's Icon Set; every other file is
 * shown for context only and gets the generic `file-text` glyph so it doesn't
 * read as another code file.
 */
export function fileIcon(name: string): 'file-code' | 'file-text' {
  return isMarkdownFile(name) ? 'file-code' : 'file-text'
}

/** Lucide icon name for a sidebar folder row's open/closed state. */
export function folderIcon(open: boolean): 'folder' | 'folder-open' {
  return open ? 'folder-open' : 'folder'
}

/** Adopt a Rust `Workspace`, updating the store and the Header breadcrumb name. */
function adopt(ws: Workspace): void {
  workspace.set({ root: ws.root, tree: ws.tree })
  workspaceName.set(ws.tree.name)
}

/**
 * Open the OS folder picker (Rust-side, so the pick is the only new allowlist
 * root). Cancelling is a no-op; the store and breadcrumb are only touched on a
 * real pick. With a folder ALREADY open, the pick instead spawns a whole new
 * app instance for the chosen dir (VS Code's second window) — the current
 * process neither adopts the folder nor gains a grant for it, keeping the two
 * instances' allowlists and workspaces fully independent.
 */
export async function openWorkspace(): Promise<void> {
  try {
    if (get(workspace).root !== null) {
      await invoke('pick_folder_new_instance')
      return
    }
    const ws = await invoke<Workspace | null>('open_workspace_dialog')
    if (ws === null) return // cancelled
    adopt(ws)
  } catch (e) {
    reportError(`Could not open workspace folder: ${String(e)}`)
  }
}

/**
 * Close the open folder: delete the persisted restore pointer, then reset the
 * store exactly inverse of `adopt` (root/tree null + breadcrumb). Open files
 * and the doc stay as they are (VS Code behavior); selection/clipboard clear
 * automatically via fileops.ts's workspace.subscribe hook. The local close
 * happens even if deleting the pointer fails — a stale pointer only means the
 * folder comes back on next launch, which beats a close button that does
 * nothing.
 */
export async function closeWorkspace(): Promise<void> {
  try {
    await invoke('close_workspace')
  } catch (e) {
    reportError(`Could not close folder: ${String(e)}`)
  }
  workspace.set({ root: null, tree: null })
  workspaceName.set(null)
}

/**
 * Re-walk the current root (window refocus / a save landing a new file). On
 * error the stale tree is kept so a transient failure doesn't blank the sidebar.
 */
export async function refreshWorkspace(): Promise<void> {
  const root = get(workspace).root
  if (root === null) return
  try {
    const ws = await invoke<Workspace>('list_workspace', { root })
    adopt(ws)
  } catch (e) {
    reportError(`Could not refresh workspace: ${String(e)}`)
  }
}

/**
 * Restore the last workspace on launch. The root comes from Rust's own config
 * file (never a webview-supplied path), so this cannot mint a grant. A `null`
 * result — nothing saved, or the folder vanished — leaves the store empty.
 */
export async function restoreWorkspace(): Promise<void> {
  try {
    const ws = await invoke<Workspace | null>('restore_workspace')
    if (ws === null) return
    adopt(ws)
  } catch {
    // No workspace to restore is not an error worth surfacing on launch.
  }
}

/**
 * Adopt a `--workspace <dir>` handed to this instance on its command line (a
 * second instance spawned by `pick_folder_new_instance`). The Rust side takes
 * the pending dir at most once, grants it, walks it, and deliberately does NOT
 * persist it — two instances must not clobber each other's restore pointer.
 * Returns whether a startup workspace was adopted, so the caller knows to skip
 * the ordinary restore. Errors are swallowed like `restoreWorkspace`'s: a
 * launch hiccup here just falls back to restoring (or an empty sidebar).
 */
export async function takeStartupWorkspace(): Promise<boolean> {
  try {
    const ws = await invoke<Workspace | null>('take_startup_workspace')
    if (ws === null) return false
    adopt(ws)
    return true
  } catch {
    return false
  }
}

/**
 * Wire up the workspace for the app lifetime: adopt a CLI-provided startup
 * workspace (which wins over — and skips — the persisted restore pointer),
 * else restore the last folder; refresh the tree when the open document's path
 * changes (a Save As into the workspace shows the file immediately) and when
 * the window regains focus (external edits happen while unfocused). Returns an
 * async teardown, matching `initFileSync`.
 */
export function initWorkspace(): Promise<() => void> {
  takeStartupWorkspace().then((adopted) => {
    if (!adopted) restoreWorkspace()
  })

  let lastPath: string | null = get(doc).path
  const unsubDoc = doc.subscribe((s) => {
    if (s.path === lastPath) return
    lastPath = s.path
    if (s.path !== null) refreshWorkspace()
  })

  const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) refreshWorkspace()
  })

  return unlistenFocus.then((unlisten) => () => {
    unsubDoc()
    unlisten()
  })
}
