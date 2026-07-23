import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { listenScoped, setWindowTitle, type Routed } from './windowing'
import { doc, isDirty } from './doc'
import { openPath, openDrainedEntries, type OpenedEntry } from './files'
import { firstMarkdownPath } from './fileTree'
import { initFileSync } from './fileSync'
import { openList, previewPath } from './openList'
import { initWorkspace, workspace } from './workspace'
import { exportTick, windowTitle } from './ui'
import { exportDocument } from './export'
import { reportError } from './errors'
import { logWarn } from './logging'

/**
 * App boot wiring, extracted from App.svelte's onMount so each piece is
 * unit-testable: menu/window event subscriptions, the startup file drains,
 * and the store-driven native-chrome mirrors (window title, read-only menu
 * check mark). App.svelte supplies the UI-flow closures (guarded opens,
 * close-tab routing) and calls {@link bootApp} once on mount.
 */

/** Event label -> handler, subscribed via listenScoped (MODE B target filter). */
export type MenuEventMap = Record<string, (payload: Routed | null) => void>

/**
 * Subscribe every entry of `events`. Returns a SYNC teardown that unlistens
 * all of them once the underlying registrations resolve — the same
 * `Promise.all(...).then(fns => ...)` shape App.svelte's onMount used.
 */
export function wireEvents(events: MenuEventMap): () => void {
  const registrations = Promise.all(
    Object.entries(events).map(([event, handler]) => listenScoped(event, handler)),
  )
  return () => {
    void registrations.then((fns) => fns.forEach((f) => f()))
  }
}

/**
 * Push the read-only flag to the native File-menu "Read Only" check mark.
 * The doc store is the single source of truth: Finder read-only opens, the
 * banner's "Enable editing" button, and the manual toggle all change
 * $doc.readonly, and {@link initReadonlyMenuSync} funnels every change
 * through here. Also called directly when a toggle is refused/cancelled, to
 * undo muda's optimistic on-click flip (macOS flips the check before the
 * event reaches us; if the store didn't actually change, the subscription
 * won't fire, so the caller re-asserts the real value). Menu-sync failure is
 * non-fatal — the check mark is cosmetic — so errors are swallowed.
 */
export function syncReadonlyMenu(checked: boolean): void {
  void invoke('set_readonly_menu_state', { checked }).catch((e) =>
    logWarn('readonly menu sync failed', e),
  )
}

/**
 * Mirror $doc.readonly onto the native "Read Only" check mark. Fires on
 * subscribe (seeding the check to the current state) and on every readonly
 * transition; gated on the flag actually changing so ordinary keystroke-driven
 * store updates don't spam the IPC bridge.
 */
export function initReadonlyMenuSync(): () => void {
  let lastReadonly: boolean | null = null
  return doc.subscribe((s) => {
    if (s.readonly === lastReadonly) return
    lastReadonly = s.readonly
    syncReadonlyMenu(s.readonly)
  })
}

/**
 * Header's Export button increments exportTick rather than calling
 * exportDocument() directly (ui.ts's requestExport contract) — skip the
 * subscribe's immediate replay of the current value so booting doesn't
 * trigger a spurious export.
 */
export function initExportOnTick(onExport: () => void = exportDocument): () => void {
  let firstExportTick = true
  return exportTick.subscribe(() => {
    if (firstExportTick) {
      firstExportTick = false
      return
    }
    onExport()
  })
}

/**
 * Mirror the doc onto the native window title (Mission Control, Cmd-Tab,
 * taskbar; macOS hides in-window title text via hiddenTitle). $doc updates on
 * every keystroke, so gate the IPC on the computed title actually changing —
 * it then fires on subscribe and after that only on filename changes and
 * clean<->dirty flips.
 */
export function initWindowTitleSync(): () => void {
  let lastTitle = ''
  return doc.subscribe((s) => {
    const t = windowTitle(s.path, isDirty(s))
    if (t !== lastTitle) {
      lastTitle = t
      setWindowTitle(t)
    }
  })
}

/**
 * A spawned document window (doc-N) drains the file it was created to host
 * (set by open_document_window). Drains exactly once — a re-mount gets None.
 * The label is derived Rust-side from the Tauri-injected WebviewWindow (not
 * passed by the caller), so a window can only ever drain its OWN hand-off —
 * see take_window_file in lib.rs. Returns whether a file was actually
 * assigned, so {@link drainStartupFiles} can decide whether this window also
 * needs to drain the unrelated, process-global OpenedFiles queue (it must
 * not, see there). A drain failure is surfaced via the error banner
 * (reportError convention) and treated as "no assignment" so the window still
 * falls back to the global queue rather than silently sitting on a blank
 * untitled doc.
 */
export async function takeAssignedFile(): Promise<boolean> {
  try {
    const assigned = await invoke<{ path: string; readonly: boolean } | null>('take_window_file')
    if (assigned) {
      openPath(assigned.path, { readonly: assigned.readonly })
      return true
    }
    return false
  } catch (e) {
    reportError(`Could not open the file assigned to this window: ${String(e)}`)
    return false
  }
}

/**
 * Open the files the OS or a spawner handed us (.md association double-click,
 * argv of a new instance). Drains the Rust-side buffer and routes the whole
 * batch through openDrainedEntries: the first entry becomes the active doc
 * (MODE A, in place via `openFirst` — App passes a guarded openPath) or its
 * own window (MODE B); the rest surface without stealing activation. Each
 * entry carries its OWN readonly flag from Rust — Finder opens keep the
 * read-only safety net, argv files open editable. Called at boot (cold
 * launch) and on each `file:opened` ping. Returns whether the drain yielded
 * any entries at all, so the boot sequencing knows this window was claimed
 * (see {@link drainStartupFiles}).
 */
export async function drainOpenedFiles(
  openFirst: (path: string, readonly: boolean) => void,
): Promise<boolean> {
  const entries = await invoke<OpenedEntry[]>('take_opened_files')
  openDrainedEntries(entries, openFirst)
  return entries.length > 0
}

/**
 * The boot-time startup-file sequencing. A spawned doc-N window (MODE B) is
 * created to host exactly one file, handed off via PendingWindowFile; it must
 * never ALSO race to drain the unrelated, process-global OpenedFiles queue
 * (that queue belongs to whichever window is focused at Finder-open time).
 * Running both calls unawaited let a freshly-spawned window steal a
 * Finder-open meant for a different window, or let the two hand-offs clobber
 * each other with no error surfaced. Awaiting the per-window hand-off FIRST,
 * and only falling back to the global drain when this window has no
 * assignment of its own, makes the two mutually exclusive instead of
 * concurrent.
 *
 * Returns whether ANYTHING claimed this window (a per-window assignment or at
 * least one drained global entry) — the startup-file half of the "is this
 * window truly unclaimed?" question the boot auto-preview asks (see
 * {@link maybeAutoOpenBootPreview}).
 */
export async function drainStartupFiles(
  openFirst: (path: string, readonly: boolean) => void,
): Promise<boolean> {
  const hadAssignedFile = await takeAssignedFile()
  if (hadAssignedFile) return true
  // Cold launch / main window: pick up the file the app was opened with.
  return drainOpenedFiles(openFirst)
}

/**
 * The menu:close_tab (Cmd+W) routing decision, pure for unit tests. Cmd+W
 * closes the active entry (pinned or preview) through the same onCloseFile
 * path as the strip's close button. On an untitled doc the "tab" being closed
 * is the scratch buffer, NOT the window: while pinned tabs or a preview are
 * still alive, dismiss the scratch (guarded — unsaved edits still prompt) and
 * land back on the preview (kept as a preview, avoiding a stale italic row)
 * or the last pinned entry. Only when nothing else is open does Cmd+W fall
 * through to closing the window — that truly-empty case is the VS Code
 * behavior.
 */
export type CloseTabDecision =
  | { kind: 'close-file'; path: string }
  | { kind: 'reopen-preview'; path: string }
  | { kind: 'reopen-pinned'; path: string }
  | { kind: 'close-window' }

export function closeTabDecision(
  docPath: string | null,
  preview: string | null,
  pinned: string[],
): CloseTabDecision {
  if (docPath !== null) return { kind: 'close-file', path: docPath }
  if (preview !== null) return { kind: 'reopen-preview', path: preview }
  if (pinned.length > 0) return { kind: 'reopen-pinned', path: pinned[pinned.length - 1] }
  return { kind: 'close-window' }
}

/**
 * A window that boots with a restored/assigned workspace but NO document
 * would otherwise land on a useless untitled scratch; instead, auto-open the
 * workspace's first markdown file (tree render order — firstMarkdownPath).
 * It opens as a PREVIEW deliberately: preview keeps the auto-open unobtrusive
 * — an italic strip row the next single click simply replaces, promoted to a
 * real pinned tab only if the user actually edits it. (An empty-state screen
 * was rejected as new design surface.)
 *
 * Only fires when the window is truly unclaimed, re-checked here at fire
 * time: the doc store still holds a clean, empty untitled scratch and nothing
 * is open or previewed. The caller (bootApp) has already established the
 * other two boundaries — the startup drains yielded nothing, and the
 * workspace at hand arrived from the BOOT restore/handoff, not a later
 * user-driven folder open. A workspace with no markdown files keeps the
 * untitled scratch.
 */
export function maybeAutoOpenBootPreview(openPreview: (path: string) => void): void {
  const ws = get(workspace)
  if (ws.root === null || ws.tree === null) return
  const d = get(doc)
  if (d.path !== null || d.content !== '' || isDirty(d)) return
  if (get(openList).length > 0 || get(previewPath) !== null) return
  const first = firstMarkdownPath(ws.tree)
  if (first !== null) openPreview(first)
}

/**
 * Run the whole boot sequence: subscribe the menu/window events, drain the
 * startup files (per-window hand-off first, then the global queue), start the
 * file watcher and workspace restore, and wire the store-driven native-chrome
 * mirrors. Returns one SYNC teardown for all of it — initFileSync and
 * initWorkspace return Promise<() => void>, resolved inside the teardown the
 * same way App.svelte's onMount cleanup did.
 *
 * `openBootPreview` is App's preview-open closure (its handleOpenFile with
 * {preview: true}), invoked at most once for the boot auto-preview (see
 * {@link maybeAutoOpenBootPreview}). The sequencing makes the startup drains
 * win: the auto-preview waits for BOTH the boot workspace restore to settle
 * (initWorkspace's callback — boot-time only by construction, so a folder the
 * user opens mid-session never auto-opens) AND the startup-file drains to
 * report whether anything claimed this window.
 */
export function bootApp(opts: {
  menuEvents: MenuEventMap
  openStartupFile: (path: string, readonly: boolean) => void
  openBootPreview: (path: string) => void
}): () => void {
  const teardownEvents = wireEvents(opts.menuEvents)
  const startupClaimed = drainStartupFiles(opts.openStartupFile)
  const teardownSync = initFileSync() // watch the open file for external changes
  // Restore + refresh the workspace tree; once the boot restore settles, an
  // unclaimed window auto-previews the workspace's first markdown file.
  const teardownWorkspace = initWorkspace(() => {
    void startupClaimed.then((claimed) => {
      if (!claimed) maybeAutoOpenBootPreview(opts.openBootPreview)
    })
  })
  const teardownExport = initExportOnTick()
  const teardownReadonlyMenu = initReadonlyMenuSync()
  const teardownTitle = initWindowTitleSync()
  return () => {
    teardownEvents()
    teardownSync.then((fn) => fn())
    teardownWorkspace.then((fn) => fn())
    teardownExport()
    teardownReadonlyMenu()
    teardownTitle()
  }
}
