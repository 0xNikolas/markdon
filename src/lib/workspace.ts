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
 * real pick.
 */
export async function openWorkspace(): Promise<void> {
  try {
    const ws = await invoke<Workspace | null>('open_workspace_dialog')
    if (ws === null) return // cancelled
    adopt(ws)
  } catch (e) {
    reportError(`Could not open workspace folder: ${String(e)}`)
  }
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
 * Wire up the workspace for the app lifetime: restore the last folder, refresh
 * the tree when the open document's path changes (a Save As into the workspace
 * shows the file immediately) and when the window regains focus (external edits
 * happen while unfocused). Returns an async teardown, matching `initFileSync`.
 */
export function initWorkspace(): Promise<() => void> {
  restoreWorkspace()

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
