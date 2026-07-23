import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { get, writable, type Writable } from 'svelte/store'
import { doc } from './doc'
import { reportFailure } from './errors'
import { logWarn, fireAndForget } from './logging'
import { openList, previewPath } from './openList'
import { isInsideRoot, workspaceName } from './ui'
import { listenScoped } from './windowing'
import { basename } from './paths'

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
 * True for image files the sidebar can VIEW — a distinct non-editable overlay
 * over the editor area, NOT an editable document. The raster types plus svg
 * (which renders through <img> like any other), matched on extension
 * case-insensitively.
 */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i
export function isImageFile(name: string): boolean {
  return IMAGE_RE.test(name)
}

/**
 * Lucide icon name for a sidebar file row. Markdown files (openable as
 * documents) get `file-code`, matching the design's Icon Set; image files
 * (viewable) get the `image` glyph; every other file is shown for context
 * only and gets the generic `file-text` glyph so it doesn't read as another
 * code file.
 */
export function fileIcon(name: string): 'file-code' | 'file-text' | 'image' {
  if (isMarkdownFile(name)) return 'file-code'
  if (isImageFile(name)) return 'image'
  return 'file-text'
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
    reportFailure('open workspace folder', e)
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
  const name = basename(trimmed)
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
    reportFailure('reopen workspace', e)
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
    reportFailure('close folder', e)
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
    reportFailure('refresh workspace', e)
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
 * The whole persisted Open Files strip for a workspace: the pinned rows in
 * strip order (`tabs`), the volatile italic preview row (`preview`, never one
 * of `tabs`), and the file showing in the editor (`active` — one of `tabs`,
 * or `preview`, or `null` for a scratch). Mirrors Rust `WorkspaceTabs`.
 */
export interface WorkspaceTabs {
  tabs: string[]
  preview: string | null
  active: string | null
}

/**
 * Last {tabs,preview,active} snapshot written through per root, serialized —
 * the settings.ts `lastPersisted`-style guard: {@link recordTabState} skips
 * the IPC write when the strip it would store already matches, so store churn
 * (and a restore that SETS the stores) never spams `save_workspace_ui`. Only a
 * suppression cache: staleness on failure is harmless (the next differing
 * strip writes again).
 */
const lastWrittenUi = new Map<string, string>()

/** Test support: forget the per-root last-written guard and drop any pending
    debounced write. */
export function resetTabRecording(): void {
  lastWrittenUi.clear()
  if (tabWriteTimer !== null) {
    clearTimeout(tabWriteTimer)
    tabWriteTimer = null
  }
}

/**
 * Build the strip snapshot for `root` from the live stores, keeping ONLY paths
 * inside the root: `tabs` is openList ∩ root, `preview` the preview path when
 * inside the root (it is never in openList), `active` the doc's path when
 * inside the root — a standalone/other-folder doc persists `active: null`, the
 * same isInsideRoot gate the old last-file recorder used.
 */
function currentTabSnapshot(root: string): WorkspaceTabs {
  const tabs = get(openList).filter((p) => isInsideRoot(p, root))
  const pv = get(previewPath)
  const preview = pv !== null && isInsideRoot(pv, root) ? pv : null
  const active = get(doc).path
  return { tabs, preview, active: active !== null && isInsideRoot(active, root) ? active : null }
}

/**
 * Pre-stamp the write-through guard so a restore that sets the stores to this
 * exact strip does NOT echo a `save_workspace_ui` straight back (settings.ts
 * `applyRemote` pre-stamping `lastPersisted`). The caller passes the strip it
 * is about to install; the eventual debounced {@link recordTabState} computes
 * the same serialization and suppresses. Serialization MUST match
 * currentTabSnapshot's field order.
 */
export function stampTabState(root: string, state: WorkspaceTabs): void {
  lastWrittenUi.set(root, JSON.stringify(state))
}

/**
 * Persist the current workspace's whole Open Files strip (the Rust-owned
 * per-workspace ui.json, restored by appBoot on the next open of this
 * workspace). Purely additive per root: paths outside the current root are
 * excluded, and no root's state is ever written under another's key, so a
 * standalone file open can never clobber a workspace's tabs. The serialized
 * last-written guard suppresses an unchanged re-write (and a restore's own
 * store-sets, pre-stamped via {@link stampTabState}). With no root open there
 * is nothing to record against. Best-effort: a failed write only costs the
 * restore, never an error banner — buffer content is never persisted here, so
 * a dropped write can never lose unsaved edits.
 */
function recordTabState(): void {
  const root = get(workspace).root
  if (root === null) return
  const snapshot = currentTabSnapshot(root)
  const serialized = JSON.stringify(snapshot)
  if (lastWrittenUi.get(root) === serialized) return
  lastWrittenUi.set(root, serialized)
  fireAndForget('save_workspace_ui', 'workspace ui save failed', {
    root,
    tabs: snapshot.tabs,
    preview: snapshot.preview,
    active: snapshot.active,
  })
}

/**
 * Trailing-edge debounce over {@link recordTabState}: a burst of strip changes
 * (a multi-file drain pinning several rows, a bulk close) coalesces into ONE
 * write instead of one per store update. The window is short enough that the
 * strip is settled well before a normal quit; {@link flushTabWrite} covers the
 * tail on window close.
 */
const TAB_WRITE_DEBOUNCE_MS = 250
let tabWriteTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTabWrite(): void {
  if (tabWriteTimer !== null) clearTimeout(tabWriteTimer)
  tabWriteTimer = setTimeout(() => {
    tabWriteTimer = null
    recordTabState()
  }, TAB_WRITE_DEBOUNCE_MS)
}

/**
 * Flush a pending debounced strip write immediately — called from the window
 * close path (App.svelte `closeThisWindow`) and this module's teardown so the
 * final tab set before the window is destroyed is never lost to the debounce.
 * A no-op when nothing is pending.
 */
export function flushTabWrite(): void {
  if (tabWriteTimer === null) return
  clearTimeout(tabWriteTimer)
  tabWriteTimer = null
  recordTabState()
}

/**
 * Wire up the workspace for the app lifetime: adopt a CLI-provided startup
 * workspace, restoring the persisted last folder ONLY on a non-handed-off
 * (cold) launch — a spawned child starts folder-less rather than adopting its
 * spawner's folder; refresh the tree when the open document's path changes (a
 * Save As into the workspace shows the file immediately); write the whole Open
 * Files strip through to the workspace's ui.json whenever it changes (debounced
 * via {@link scheduleTabWrite}, over the openList / previewPath / doc.path
 * stores), so reopening the workspace rebuilds every row; and refresh when the
 * window regains focus (external edits happen while unfocused). Also keeps a
 * Rust-side recursive watcher pointed at the current root (installed/replaced
 * on every root transition, torn down on close), whose debounced
 * `workspace:changed` events refresh the tree WITHOUT a refocus. Returns an
 * async teardown, matching `initFileSync` — which FLUSHES any pending strip
 * write so the final tab set isn't lost when the window tears down.
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

  // The active file (doc.path) is one third of the persisted strip; a path
  // change schedules a write (content-only churn — keystrokes — never does,
  // since it doesn't change the strip). It also drives the tree refresh.
  let lastPath: string | null = get(doc).path
  const unsubDoc = doc.subscribe((s) => {
    if (s.path === lastPath) return
    lastPath = s.path
    scheduleTabWrite()
    if (s.path !== null) refreshWorkspace()
  })

  // The other two thirds: the pinned rows and the preview slot. Skip each
  // store's replay-on-subscribe (Svelte fires it synchronously with the
  // current value) so init itself schedules nothing — only a real post-init
  // change writes, and a boot/mid-session restore pre-stamps the guard so its
  // own store-sets suppress rather than echo a save back.
  let firstOpenList = true
  const unsubOpenList = openList.subscribe(() => {
    if (firstOpenList) {
      firstOpenList = false
      return
    }
    scheduleTabWrite()
  })
  let firstPreview = true
  const unsubPreview = previewPath.subscribe(() => {
    if (firstPreview) {
      firstPreview = false
      return
    }
    scheduleTabWrite()
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
      fireAndForget('watch_workspace', 'workspace watch failed', { root: s.root })
    } else {
      fireAndForget('unwatch_workspace', 'unwatch_workspace failed')
    }
  })

  const unlistenChanged = listenScoped('workspace:changed', () => {
    void refreshFromWatcher()
  })

  const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) refreshWorkspace()
  })

  return Promise.all([unlistenFocus, unlistenChanged]).then(([offFocus, offChanged]) => () => {
    flushTabWrite() // persist the final strip before the window tears down
    unsubDoc()
    unsubOpenList()
    unsubPreview()
    unsubWs()
    offFocus()
    offChanged()
    fireAndForget('unwatch_workspace', 'unwatch_workspace failed')
  })
}
