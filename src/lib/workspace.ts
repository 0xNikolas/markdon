import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { get, writable, type Writable } from 'svelte/store'
import { doc } from './doc'
import { reportError } from './errors'
import { logWarn } from './logging'
import { isInsideRoot, workspaceName } from './ui'
import { listenScoped } from './windowing'

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
 * The Open Recent MRU (newest-first roots) for the empty page's Recent
 * section, read from the Rust-owned state file via `list_recent_workspaces`.
 * Display-only — opening still routes through {@link openRecentWorkspace}'s
 * trust boundary. A failed read yields an empty list (the section hides)
 * rather than an error: recents are a convenience, never worth a banner.
 */
export async function listRecentWorkspaces(): Promise<string[]> {
  try {
    return await invoke<string[]>('list_recent_workspaces')
  } catch (e) {
    logWarn('recent workspaces load failed', e)
    return []
  }
}

/** How the empty page renders one recent root: basename strong, parent muted. */
export interface RecentWorkspaceDisplay {
  name: string
  parent: string
}

/**
 * Split a recent workspace root into its basename and an abbreviated parent
 * path (home shortened to `~`), mirroring the native Open Recent menu's
 * label rule (menu.rs `recent_label`) so the two surfaces never disagree.
 * Pure string work: `home` comes from the path API when available, `null`
 * skips abbreviation. Degenerate roots ('/', '') fall back to the raw root
 * with an empty parent so the row stays legible.
 */
export function recentWorkspaceDisplay(root: string, home: string | null): RecentWorkspaceDisplay {
  const trimmed = root.length > 1 ? root.replace(/\/+$/, '') : root
  const cut = trimmed.lastIndexOf('/')
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  if (name === '') return { name: trimmed, parent: '' }
  let parent = cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? '/' : ''
  const h = home === null || home === '' ? null : home.replace(/\/+$/, '')
  if (h !== null && h !== '') {
    if (parent === h) parent = '~'
    else if (parent.startsWith(`${h}/`)) parent = `~${parent.slice(h.length)}`
  }
  return { name, parent }
}

/**
 * Reopen an entry of the File > Open Recent menu (`menu:open_recent`, carrying
 * the root Rust resolved from its own MRU snapshot). Same-root is a no-op —
 * it is already open right here. With no folder open the workspace is adopted
 * in place (Rust grants + walks + persists, exactly like a dialog pick); with
 * a folder already open Rust spawns a whole new instance for the root and
 * returns null (VS Code second-window semantics, mirroring `openWorkspace`),
 * so this process adopts nothing. A vanished folder rejects (Rust drops it
 * from the MRU) and lands in the error banner.
 */
export async function openRecentWorkspace(root: string): Promise<void> {
  const current = get(workspace).root
  if (current === root) return
  try {
    const ws = await invoke<Workspace | null>('open_recent_workspace', {
      root,
      currentRoot: current,
    })
    if (ws !== null) adopt(ws)
  } catch (e) {
    reportError(`Could not reopen workspace: ${String(e)}`)
  }
}

/**
 * Close the open folder: delete the persisted restore pointer, then reset the
 * store exactly inverse of `adopt` (root/tree null + breadcrumb). The current
 * root rides along so Rust can prove ownership — the pointer file is shared
 * by every running instance, and one whose folder was never persisted (a
 * `--workspace` child) must not delete the pointer another instance saved;
 * with no root there is nothing to close remotely at all. Open files and the
 * doc stay as they are (VS Code behavior); selection/clipboard clear
 * automatically via fileops.ts's workspace.subscribe hook. The local close
 * happens even if deleting the pointer fails — a stale pointer only means the
 * folder comes back on next launch, which beats a close button that does
 * nothing.
 */
export async function closeWorkspace(): Promise<void> {
  const root = get(workspace).root
  try {
    if (root !== null) await invoke('close_workspace', { root })
  } catch (e) {
    reportError(`Could not close folder: ${String(e)}`)
  }
  workspace.set({ root: null, tree: null })
  workspaceName.set(null)
}

/**
 * Re-walk the current root (window refocus / a save landing a new file). On
 * error the stale tree is kept so a transient failure doesn't blank the sidebar.
 * The walk result is DROPPED when the root changed while it was in flight
 * (Close Folder, or a switch to another root): adopting it would resurrect the
 * closed workspace — and re-install its Rust watcher via initWorkspace's
 * root-transition subscription. Same post-await re-check pattern as
 * fileSync.ts's reconcileWithDisk.
 */
export async function refreshWorkspace(): Promise<void> {
  const root = get(workspace).root
  if (root === null) return
  try {
    const ws = await invoke<Workspace>('list_workspace', { root })
    if (get(workspace).root !== root) return // root changed mid-walk: stale result
    adopt(ws)
  } catch (e) {
    reportError(`Could not refresh workspace: ${String(e)}`)
  }
}

let refreshInFlight = false

/**
 * Watcher-driven refresh (`workspace:changed` deliveries). Bursts arriving
 * while a walk is already running are DROPPED rather than queued — the Rust
 * side already coalesces at 500ms, and the focus/doc-change refreshes are the
 * backstop for anything a dropped burst would have shown.
 */
export async function refreshFromWatcher(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    await refreshWorkspace()
  } finally {
    refreshInFlight = false
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
  } catch (e) {
    // No workspace to restore is not an error worth surfacing on launch.
    logWarn('workspace restore failed', e)
  }
}

/**
 * Adopt a `--workspace <dir>` handed to this instance on its command line (a
 * second instance spawned by `pick_folder_new_instance`). The Rust side takes
 * the pending dir at most once, grants it, walks it, and deliberately does NOT
 * persist it — two instances must not clobber each other's restore pointer.
 * Returns whether the ordinary restore must be SKIPPED: true for every
 * handed-off launch (a `--workspace` dir and/or argv files), even when no
 * workspace was adoptable — the dir vanished, or the hand-off carried only
 * files — because falling back to `restoreWorkspace` would make the child
 * silently adopt its SPAWNER's persisted folder. Cold launches (no argv)
 * return false and keep restoring. Errors are swallowed like
 * `restoreWorkspace`'s: an IPC hiccup here just falls back to restoring (or
 * an empty sidebar), same as a cold launch.
 */
export async function takeStartupWorkspace(): Promise<boolean> {
  try {
    const handoff = await invoke<{ workspace: Workspace | null; suppress_restore: boolean }>(
      'take_startup_workspace',
    )
    if (handoff.workspace !== null) adopt(handoff.workspace)
    return handoff.suppress_restore
  } catch (e) {
    logWarn('startup workspace handoff failed', e)
    return false
  }
}

/**
 * Last path persisted per root — the settings.ts `lastPersisted`-style guard:
 * skips the IPC write when the value on disk is already what we'd store, so
 * repeated store churn on one path never spams `save_workspace_ui`. Only a
 * suppression cache: staleness on failure is harmless (the next differing
 * path writes again).
 */
const lastRecordedUi = new Map<string, string>()

/** Test support: forget the per-root last-recorded guard. */
export function resetLastFileRecording(): void {
  lastRecordedUi.clear()
}

/**
 * Record `path` as the current workspace's last-open file (the Rust-owned
 * per-workspace ui.json, restored by appBoot on the next open of this
 * workspace). Only paths INSIDE the current root are recorded — standalone
 * opens (Finder files, dialog picks outside the folder) are not workspace
 * working state — and with no root open there is nothing to record against.
 * Best-effort: a failed write only costs the restore, never an error banner.
 */
export function recordLastFile(path: string): void {
  const root = get(workspace).root
  if (root === null || !isInsideRoot(path, root)) return
  if (lastRecordedUi.get(root) === path) return
  lastRecordedUi.set(root, path)
  invoke('save_workspace_ui', { root, lastFile: path }).catch((e) =>
    logWarn('workspace ui save failed', e),
  )
}

/**
 * Wire up the workspace for the app lifetime: adopt a CLI-provided startup
 * workspace, restoring the persisted last folder ONLY on a non-handed-off
 * (cold) launch — a spawned child starts folder-less rather than adopting its
 * spawner's folder; refresh the tree when the open document's path changes (a
 * Save As into the workspace shows the file immediately), record that path as
 * the workspace's last-open file ({@link recordLastFile}), and refresh when
 * the window regains focus (external edits happen while unfocused). Also
 * keeps a Rust-side recursive watcher pointed at the current root
 * (installed/replaced on every root transition, torn down on close), whose
 * debounced `workspace:changed` events refresh the tree WITHOUT a refocus.
 * Returns an async teardown, matching `initFileSync`.
 *
 * `onBootRestoreSettled` fires exactly once, after the boot-time
 * handoff/restore chain has fully settled (workspace adopted — the store is
 * already set — or provably nothing to adopt). It is the only reliable
 * boundary between "this workspace arrived at boot" and "the user opened a
 * folder later": appBoot's boot-settlement restore of the workspace's
 * last-open file runs on the former, while mid-session root transitions ride
 * appBoot's own store subscription — and a plain store subscription alone
 * cannot tell the two apart when the boot restore found nothing.
 */
export function initWorkspace(onBootRestoreSettled?: () => void): Promise<() => void> {
  takeStartupWorkspace().then(async (suppressRestore) => {
    if (!suppressRestore) await restoreWorkspace()
    onBootRestoreSettled?.()
  })

  let lastPath: string | null = get(doc).path
  const unsubDoc = doc.subscribe((s) => {
    if (s.path === lastPath) return
    lastPath = s.path
    if (s.path !== null) {
      refreshWorkspace()
      recordLastFile(s.path)
    }
  })

  // Root transitions (dialog open, restore, startup handoff, close) install /
  // replace / drop the Rust watcher. Every refresh re-adopts the SAME root, so
  // the guard keeps plain refreshes from re-invoking watch_workspace. Fail
  // open on error: a folder that can't be watched (e.g. inotify exhaustion)
  // still refreshes on focus/doc-change, so logWarn — never a banner.
  let watchedRoot: string | null = get(workspace).root
  const unsubWs = workspace.subscribe((s) => {
    if (s.root === watchedRoot) return
    watchedRoot = s.root
    if (s.root !== null) {
      invoke('watch_workspace', { root: s.root }).catch((e) => logWarn('workspace watch failed', e))
    } else {
      invoke('unwatch_workspace').catch((e) => logWarn('unwatch_workspace failed', e))
    }
  })

  const unlistenChanged = listenScoped('workspace:changed', () => {
    void refreshFromWatcher()
  })

  const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) refreshWorkspace()
  })

  return Promise.all([unlistenFocus, unlistenChanged]).then(([offFocus, offChanged]) => () => {
    unsubDoc()
    unsubWs()
    offFocus()
    offChanged()
    invoke('unwatch_workspace').catch((e) => logWarn('unwatch_workspace failed', e))
  })
}
