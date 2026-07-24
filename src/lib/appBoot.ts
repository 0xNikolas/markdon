import * as ipc from './ipc'
import { get } from 'svelte/store'
import { listenScoped, setWindowTitle, type Routed } from './windowing'
import { doc, isDirty, showEmptyState } from './doc'
import { openPath, openDrainedEntries } from './files'
import { initFileSync } from './fileSync'
import { openList, previewPath } from './openList'
import { initWorkspace, workspace, stampTabState, type WorkspaceTabs } from './workspace'
import { emptyState, exportTick, imageView } from './ui'
import { windowTitle } from './paths'
import { exportDocument } from './export'
import { reportFailure } from './errors'
import { logWarn, fireAndForget } from './logging'

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
  fireAndForget('set_readonly_menu_state', 'readonly menu sync failed', { checked })
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
    // The Header's Export button stays clickable while the empty page is
    // shown; with no document there is nothing to export, so the tick is
    // dropped here — the menu route is gated in App.svelte's shared gate.
    if (get(emptyState)) return
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
  const apply = () => {
    const iv = get(imageView)
    // The image view wins over both $doc and $emptyState: it titles by the
    // image's filename, never dirty (an image is not an editable document).
    const s = get(doc)
    const t =
      iv !== null
        ? windowTitle(iv, false)
        : // The empty page has no document: plain "Markdon", no filename (the
          // pristine scratch underneath would otherwise title as "Untitled").
          windowTitle(s.path, isDirty(s), get(emptyState))
    if (t !== lastTitle) {
      lastTitle = t
      setWindowTitle(t)
    }
  }
  const unsubDoc = doc.subscribe(apply)
  const unsubEmpty = emptyState.subscribe(apply)
  const unsubImg = imageView.subscribe(apply)
  return () => {
    unsubDoc()
    unsubEmpty()
    unsubImg()
  }
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
    const assigned = await ipc.takeWindowFile()
    if (assigned) {
      openPath(assigned.path, { readonly: assigned.readonly })
      return true
    }
    return false
  } catch (e) {
    reportFailure('open the file assigned to this window', e)
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
  const entries = await ipc.takeOpenedFiles()
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
 * window truly unclaimed?" question the boot document restore asks (see
 * {@link maybeRestoreBootDocument}).
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
 * or the most recent pinned entry (index 0, the top row). Only when nothing
 * else is open does Cmd+W fall
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
  if (pinned.length > 0) return { kind: 'reopen-pinned', path: pinned[0] }
  return { kind: 'close-window' }
}

/**
 * The workspace's remembered Open Files strip, from the Rust-validated
 * per-workspace ui.json (load_workspace_ui — the counterpart of workspace.ts's
 * strip write-through). Rust returns only paths that still exist inside the
 * root (dropping stale ones), and `null` when nothing survives — so `null`
 * uniformly covers a fresh workspace, every remembered path vanishing/moving,
 * tampered state, AND an IPC failure, every one of which degrades to the same
 * fresh-scratch restore.
 */
export async function loadWorkspaceTabs(root: string): Promise<WorkspaceTabs | null> {
  try {
    return await ipc.loadWorkspaceUi(root)
  } catch (e) {
    logWarn('workspace ui load failed', e)
    return null
  }
}

/**
 * True while this window is still an unclaimed pristine scratch: the doc
 * store holds a clean, empty untitled buffer and nothing is open or
 * previewed. The strip restore's gate, checked at fire time AND re-checked
 * after its async lookup. Because cache keys ⊆ openList, an empty openList
 * also proves no dirty background buffer exists — so a restore that runs only
 * while unclaimed can never clobber unsaved edits.
 */
function windowUnclaimed(): boolean {
  const d = get(doc)
  if (d.path !== null || d.content !== '' || isDirty(d)) return false
  return get(openList).length === 0 && get(previewPath) === null
}

/**
 * The one restore rule, shared by the BOOT settlement and MID-SESSION root
 * transitions: rebuild the workspace's whole Open Files strip (`restoreTabs`
 * sets the stores and lazily loads only the active file), or open a fresh
 * untitled scratch when nothing valid is remembered.
 *
 * Guarded HARD against clobbering: it acts only while the window is still
 * {@link windowUnclaimed} — re-checked AFTER the async lookup so a
 * startup/user open (or a folder switch) landing mid-lookup always wins, and a
 * window that already holds open files/edits (a folder-less window with
 * standalone files adopting a folder mid-session) is left completely untouched
 * rather than having its strip replaced. The result is also dropped when the
 * root changed while the lookup was in flight (Close Folder, or another
 * switch), the same post-await re-check as refreshWorkspace's. Pre-stamps the
 * write-through guard with the restored strip so setting the stores does not
 * echo a save straight back (settings.ts applyRemote pattern).
 */
export async function restoreTabsForRoot(
  root: string,
  restoreTabs: (state: WorkspaceTabs) => void,
  openScratch: () => void,
): Promise<void> {
  const state = await loadWorkspaceTabs(root)
  if (get(workspace).root !== root || !windowUnclaimed()) return
  if (state === null) {
    openScratch()
    return
  }
  stampTabState(root, state)
  restoreTabs(state)
}

/**
 * Boot-settlement document restore. An UNCLAIMED window that booted with a
 * workspace rebuilds that workspace's Open Files strip ({@link
 * restoreTabsForRoot}) — or, when nothing valid is remembered, a fresh
 * untitled scratch. With no workspace at all the window shows the no-document
 * empty page (doc.showEmptyState) instead: VS Code's no-editor state, with the
 * action list as the invitation to act; an explicit Cmd+N from there still
 * yields the scratch.
 *
 * The caller (bootApp) has already established the other two boundaries: the
 * startup drains yielded nothing, and the workspace at hand arrived from the
 * BOOT restore/handoff — mid-session folder opens ride bootApp's own
 * root-transition subscription (also {@link restoreTabsForRoot}) and never
 * reach the empty page.
 */
export async function maybeRestoreBootDocument(
  restoreTabs: (state: WorkspaceTabs) => void,
  openScratch: () => void,
): Promise<void> {
  if (!windowUnclaimed()) return
  const root = get(workspace).root
  if (root === null) {
    showEmptyState()
    return
  }
  await restoreTabsForRoot(root, restoreTabs, openScratch)
}

/**
 * Run the whole boot sequence: subscribe the menu/window events, drain the
 * startup files (per-window hand-off first, then the global queue), start the
 * file watcher and workspace restore, and wire the store-driven native-chrome
 * mirrors. Returns one SYNC teardown for all of it — initFileSync and
 * initWorkspace return Promise<() => void>, resolved inside the teardown the
 * same way App.svelte's onMount cleanup did.
 *
 * `restoreTabs` (App's strip rebuilder + lazy active open) and `openScratch`
 * (App's File > New closure) are the two resolutions of the strip restore rule,
 * fired from two triggers that never overlap:
 *
 * - BOOT: once the workspace restore settles (initWorkspace's callback) AND
 *   the startup drains report the window unclaimed, the restore runs with
 *   {@link maybeRestoreBootDocument}'s guards — a startup-assigned/drained
 *   file always wins, and no workspace at all means the empty page.
 * - MID-SESSION: a root TRANSITION in the workspace store (Open Folder /
 *   Open Recent / an empty-page recent row adopting into a folder-less
 *   window — refreshes re-adopt the SAME root and don't count) runs
 *   {@link restoreTabsForRoot} directly. Gated on the boot having settled so
 *   the boot transition itself is only handled once, above; a transition to
 *   null (Close Folder) deliberately leaves the doc alone, and a window that
 *   already holds open files is left untouched by restoreTabsForRoot's own
 *   windowUnclaimed guard (its strip is never clobbered).
 */
export function bootApp(opts: {
  menuEvents: MenuEventMap
  openStartupFile: (path: string, readonly: boolean) => void
  restoreTabs: (state: WorkspaceTabs) => void
  openScratch: () => void
}): () => void {
  const teardownEvents = wireEvents(opts.menuEvents)
  const startupClaimed = drainStartupFiles(opts.openStartupFile)
  const teardownSync = initFileSync() // watch the open file for external changes
  // Mid-session root transitions rebuild that workspace's strip (or a scratch).
  // Installed BEFORE initWorkspace so the boot adopt updates lastRoot here
  // while bootSettled still gates it out.
  let bootSettled = false
  let lastRoot = get(workspace).root
  const unsubRootRestore = workspace.subscribe((s) => {
    if (s.root === lastRoot) return
    lastRoot = s.root
    if (!bootSettled || s.root === null) return
    void restoreTabsForRoot(s.root, opts.restoreTabs, opts.openScratch)
  })
  const teardownWorkspace = initWorkspace(() => {
    bootSettled = true // from here on, root transitions are user-driven
    void startupClaimed.then((claimed) => {
      if (!claimed) void maybeRestoreBootDocument(opts.restoreTabs, opts.openScratch)
    })
  })
  const teardownExport = initExportOnTick()
  const teardownReadonlyMenu = initReadonlyMenuSync()
  const teardownTitle = initWindowTitleSync()
  return () => {
    teardownEvents()
    unsubRootRestore()
    teardownSync.then((fn) => fn())
    teardownWorkspace.then((fn) => fn())
    teardownExport()
    teardownReadonlyMenu()
    teardownTitle()
  }
}
