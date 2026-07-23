<script lang="ts">
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { invoke } from '@tauri-apps/api/core'
  import { get } from 'svelte/store'
  import {
    doc,
    edit,
    newDoc,
    isDirty,
    enableEditing,
    enterReadonly,
    revertBuffer,
    adoptNormalization,
    showEmptyState,
  } from './lib/doc'
  import { recordRevert } from './lib/history'
  import {
    open,
    save,
    saveAs,
    openPath,
    openInPreferredTarget,
    stashActive,
    saveCachedBuffer,
    saveAllDirty,
  } from './lib/files'
  import { isCachedDirty, anyCachedDirty, evict, dirtyCached } from './lib/bufferCache'
  import {
    openList,
    previewPath,
    pinOpen,
    pinPreview,
    removeOpen,
    insertOpenAt,
    stripOrder,
    bulkClosePlan,
    neighbourAfterClose,
    neighbourInStrip,
    type BulkCloseKind,
  } from './lib/openList'
  import { recordClosed, takeClosed, MAX_CLOSED } from './lib/closedStack'
  import { conflict, reloadFromDisk, dismissConflict } from './lib/fileSync'
  import {
    bootApp,
    closeTabDecision,
    drainOpenedFiles,
    syncReadonlyMenu,
    type MenuEventMap,
  } from './lib/appBoot'
  import type { Routed } from './lib/windowing'
  import { allowsNativeContextMenu } from './lib/contextMenu'
  import Editor from './Editor.svelte'
  import ImageView from './ImageView.svelte'
  import EmptyState from './EmptyState.svelte'
  import SplitView from './SplitView.svelte'
  import Header from './Header.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'
  import FindBar from './FindBar.svelte'
  import SettingsModal from './SettingsModal.svelte'
  import GoToLineBar from './GoToLineBar.svelte'
  import HistoryModal from './HistoryModal.svelte'
  import QuickOpen from './QuickOpen.svelte'
  import Sidebar from './Sidebar.svelte'
  import { searchUi, openFind, openReplace, closeFind, shouldForceCloseFind } from './lib/searchPlugin'
  import { openSourceSearch, clearPendingLine } from './lib/sourceEditor'
  import { split, emptyState, imageView, isMacPlatform } from './lib/ui'
  import {
    matchKeydown,
    menuItemIds,
    type KeydownGuard,
  } from './lib/keymap'
  import type { StripRowAction } from './OpenFilesStrip.svelte'
  import { activeOverlay, openOverlay, closeOverlay, anyOverlayOpen } from './lib/overlay'
  import {
    workspace,
    openWorkspace,
    openRecentWorkspace,
    closeWorkspace,
    isImageFile,
    flushTabWrite,
    type WorkspaceTabs,
  } from './lib/workspace'
  import { revealLog, reportError, reportNotice } from './lib/errors'
  import { exportDocument } from './lib/export'
  import { flushBufferEdits } from './lib/bufferFlush'
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'

  // True while `save()` is in flight (native dialogs aren't window-parented,
  // so the modal stays clickable underneath them without this guard).
  let saving = $state(false)

  // Run `action` immediately if the document is clean; otherwise defer it behind
  // the discard-confirm modal (the 'discard' overlay) so unsaved edits are never
  // silently lost. Guards the flows where the buffer would actually be
  // DESTROYED: closing a tab, the Read-Only toggle's dirty path, and File
  // History revert. Mere switches between pathed docs go through
  // switchGuarded below instead — their dirty buffers survive in the buffer
  // cache, so they never prompt. openOverlay refuses if any overlay is
  // already up: for the gated menu paths (goto, history, readonly) that can't
  // happen, and for the ungated ones the action deliberately no-ops — the
  // buffer is left untouched, which is the safe replacement for the old
  // behavior of stacking the discard modal invisibly behind the open overlay.
  function guarded(action: () => void) {
    // Every new guard cycle invalidates any remembered deferred-preview path
    // (see pendingPreviewPath): the slot only ever describes the CURRENT
    // discard overlay's deferred action, never a previous one's.
    pendingPreviewPath = null
    // Both editors serialize on a trailing debounce, so isDirty can trail the
    // screen by ~200ms — flush first or a type-then-close races past the guard.
    flushBufferEdits()
    if (isDirty(get(doc))) openOverlay({ kind: 'discard', action })
    else action()
  }

  // The guard for SWITCH-shaped actions (opening another file, New). A dirty
  // PATHED doc is not at risk on a switch — openPath (or an explicit
  // stashActive at the call site) stashes its buffer into the cache and the
  // switch runs immediately. Only a dirty UNTITLED doc still prompts: the
  // scratch has no cache key, so switching away from it truly discards it.
  function switchGuarded(action: () => void) {
    pendingPreviewPath = null
    flushBufferEdits() // see guarded(): the dirty check must not trail the editor
    const s = get(doc)
    if (s.path === null && isDirty(s)) openOverlay({ kind: 'discard', action })
    else action()
  }

  // The path of a PREVIEW open currently deferred behind the discard overlay.
  // Needed because the second click of a tree dblclick lands on the modal
  // backdrop (the overlay mounted between the clicks), so the pin intent
  // would otherwise be lost — the file would re-open as a mere preview after
  // the prompt resolves. Only ever armed while the current doc is a dirty
  // UNTITLED scratch — the one case a preview open still defers (pathed
  // switches stash and run immediately). onBackdropDblClick uses it to
  // upgrade the deferred action in place; cleared whenever the overlay
  // resolves (discard/cancel) or a new guard cycle starts.
  let pendingPreviewPath: string | null = null

  // Dblclick on the discard backdrop while a preview open sits deferred:
  // swap the deferred action to a PINNED in-place open of the same path —
  // the second click that would have pinned it hit the backdrop instead.
  // Gated on target === currentTarget so dblclicks inside the modal itself
  // (e.g. on button text) never retarget the action.
  function onBackdropDblClick(e: MouseEvent) {
    if (e.target !== e.currentTarget) return
    const p = pendingPreviewPath
    if (p === null) return
    pendingPreviewPath = null
    activeOverlay.update((o) =>
      o?.kind === 'discard' ? { kind: 'discard', action: () => openPath(p) } : o,
    )
  }

  // File-menu "Read Only" toggle handler. Three cases off the store:
  //   - already read-only  -> lift it (identical to the banner's Enable editing)
  //   - editable + clean   -> enter read-only immediately
  //   - editable + dirty   -> route through the discard guard, entering
  //     read-only only once the buffer resolves clean (Save writes then locks;
  //     Don't Save drops the unsaved edits back to disk truth first, preserving
  //     the readonly⇒clean invariant; Cancel aborts — see cancel()).
  // enterReadonly() is itself defensive (no-ops on a dirty buffer), so the
  // guarded action restores savedContent before locking on the discard path.
  function toggleReadonly() {
    // Pending editor edits must land before the clean/dirty branch: entering
    // read-only on a stale "clean" buffer would strand un-emitted keystrokes
    // behind the readonly⇒clean invariant (edit() no-ops once locked).
    flushBufferEdits()
    const s = get(doc)
    if (s.readonly) {
      enableEditing()
    } else if (!isDirty(s)) {
      enterReadonly()
    } else {
      guarded(() => {
        const cur = get(doc)
        // Save path already cleared dirty; Don't-Save reaches here still dirty,
        // so discard the edits (revert to disk truth, remounting the editor)
        // before locking, keeping readonly⇒clean intact.
        if (isDirty(cur)) revertBuffer(cur.savedContent)
        enterReadonly()
      })
    }
  }

  // WYSIWYG editor updates. Milkdown's listener debounces (200ms), so all of
  // Crepe's mount-time normalization transactions collapse into the FIRST
  // emission: on an untouched buffer that emission is the editor's canonical
  // re-serialization of what we loaded, not a user edit — adopt it as the
  // clean baseline (doc.ts adoptNormalization; phantom-"Edited" fix) instead
  // of dirtying the doc. Every later emission is a real edit. A user managing
  // to type inside that first 200ms window gets folded into the baseline; the
  // next emission (their following keystroke) restores dirty correctly.
  // The split-view source editor (CodeMirror) is byte-accurate and keeps
  // calling edit() directly.
  function onEditorChange(md: string) {
    const s = get(doc)
    if (!s.readonly && s.content === s.savedContent && md !== s.content) {
      adoptNormalization(md)
      return
    }
    edit(md)
    promotePreviewOnEdit()
  }

  // VS Code pins a preview tab the moment it's modified: the italic slot only
  // ever holds an unmodified glance. Runs after both editors' change paths
  // (the WYSIWYG handler above and the split-view CodeMirror wrapper in the
  // template); onEditorChange's adoptNormalization early-return never reaches
  // it, so mount-time re-serialization can't pin anything.
  function promotePreviewOnEdit() {
    const s = get(doc)
    if (get(previewPath) === s.path && isDirty(s)) pinPreview()
  }

  // The one place imageView is SET: a WorkspaceTree click on an image row.
  // A distinct non-editable view mode — $doc is NOT stashed, discarded or
  // mutated, so the live document (and its unsaved buffer) is preserved and
  // losslessly restored when a later doc open clears imageView. flushBufferEdits()
  // lands the outgoing editor's pending keystrokes into $doc.content before
  // <Editor> unmounts (same reason $effect.pre flushes on $split); no discard
  // guard is needed precisely because nothing is at risk.
  function showImage(path: string) {
    flushBufferEdits()
    imageView.set(path)
  }

  // Single entry point for opening a path from the sidebar (Open Files strip
  // or Workspace tree alike). An image path routes to the non-editable image
  // view (showImage) and never touches $doc. A single click asks for a
  // PREVIEW: always in-place regardless of openMode (a glance must never spawn
  // a window), parked in the italic preview slot by openPath. A pinned open
  // routes through openInPreferredTarget (the tab/window choke-point) unless
  // `inPlace` forces this window — that is what the explicit "Open in New
  // Tab" action means even under openMode:'window'. Re-activating the
  // already-active doc without `preview` pins it: that is exactly the
  // dblclick arriving after its own first click already previewed the file.
  function handleOpenFile(path: string, opts: { preview?: boolean; inPlace?: boolean } = {}) {
    if (isImageFile(path)) {
      showImage(path)
      return
    }
    // Opening any document dismisses the image view. Explicit here (not only
    // via doc.ts's clear) to cover the re-click on the doc active UNDERNEATH
    // the image view: that pins in place and never bumps loadId, so doc.ts's
    // load-chokepoint clear wouldn't fire.
    imageView.set(null)
    if (path === get(doc).path) {
      if (!opts.preview) pinOpen(path)
      return
    }
    if (opts.preview) {
      switchGuarded(() => openPath(path, { preview: true }))
      // Only when the guard actually deferred (dirty untitled -> discard
      // overlay up) is there a pin intent to protect; an immediate open needs
      // no memory.
      if (get(activeOverlay)?.kind === 'discard') pendingPreviewPath = path
      return
    }
    if (opts.inPlace) {
      switchGuarded(() => openPath(path))
      return
    }
    openInPreferredTarget(path, (p) => switchGuarded(() => openPath(p)))
  }

  // Sidebar Open Files close affordance. Closing a tab DESTROYS its buffer,
  // so this is guard territory on both branches. A non-active entry may hold
  // dirty edits in the buffer cache: when it does, the discard modal opens
  // with the removal deferred (Save routes to saveCachedBuffer for that path
  // — the background buffer writes without becoming active); a clean
  // non-active entry closes as a bare removal — from the pinned list, or by
  // vacating the preview slot (the two are mutually exclusive by openPath's
  // invariant) — plus cache eviction. Closing the active entry (pinned or
  // preview — a preview is a normal live doc) still runs the guard against
  // the live doc, then switches to the neighbour computed BEFORE removal
  // (previous, else next, else null -> falls back to newDoc()); the
  // neighbour open restores from the cache via openPath. The preview path is
  // never in openList, but it RENDERS as the top row (above every pinned
  // one), so closing an active preview prepends it for the lookup — its
  // visual neighbour is the first (most recent) pinned entry, not a blank new
  // doc.
  // Clearing state inside the guard keeps Cancel non-destructive.
  // Remove a NON-ACTIVE strip row (pinned or preview), evict its cache entry,
  // and record it for Reopen Closed File — the shared removal step for the
  // strip close button's background branch and the context menu's bulk closes
  // (whose plans only ever contain clean background rows). The reopen index
  // is captured BEFORE removal: a pinned row's list position, or 0 for a
  // preview row (it renders at the top, so it reopens pinned at the top).
  function closeBackgroundRow(path: string) {
    const isPreview = path === get(previewPath)
    const index = isPreview ? 0 : get(openList).indexOf(path)
    if (isPreview) previewPath.set(null)
    else openList.update((l) => removeOpen(l, path))
    evict(path)
    if (index !== -1) recordClosed(path, index)
  }

  function onCloseFile(path: string) {
    if (path !== get(doc).path) {
      if (isCachedDirty(path)) {
        pendingPreviewPath = null
        openOverlay({
          kind: 'discard',
          action: () => closeBackgroundRow(path),
          save: () => saveCachedBuffer(path),
        })
      } else {
        closeBackgroundRow(path)
      }
      return
    }
    guarded(() => {
      // Don't Save reaches here with the doc STILL dirty (discard() never
      // reverts) — neutralize it first, mirroring toggleReadonly's action.
      // Without this, openPath(next)'s stashActive would see a dirty doc no
      // longer in openList, defensively re-pin it and stash the buffer the
      // user just chose to destroy — resurrecting the closed tab, and letting
      // a later window-close Save write the discarded edits to disk.
      const cur = get(doc)
      if (isDirty(cur)) revertBuffer(cur.savedContent)
      const list = get(openList)
      const isPreview = path === get(previewPath)
      const lookup = isPreview ? [path, ...list] : list
      const next = neighbourAfterClose(lookup, path, get(doc).path)
      const closedIndex = isPreview ? 0 : list.indexOf(path)
      previewPath.update((pv) => (pv === path ? null : pv))
      openList.update((l) => removeOpen(l, path))
      evict(path) // close destroys: drop any (defensive) cache entry with the row
      if (closedIndex !== -1) recordClosed(path, closedIndex)
      // Closing the LAST open file lands on the no-document empty page (VS
      // Code parity) — an explicit Cmd+N from there still yields the scratch.
      if (next === null) showEmptyState()
      else openPath(next)
    })
  }

  // Reopen Closed File (Cmd/Ctrl+Shift+T): pop the newest recorded close and
  // restore it PINNED at its old strip index (insertOpenAt clamps; a path
  // meanwhile reopened by hand keeps its current row). The cache entry was
  // evicted at close time, so openPath re-reads from disk — reopen never
  // resurrects discarded edits. Entries whose file no longer exists are
  // skipped SILENTLY: a cheap read_file probe runs first, so a vanished file
  // falls through to the next entry instead of spawning an error banner (the
  // stack is capped at MAX_CLOSED, bounding the loop; a probe-then-open race
  // still lands in openPath's ordinary error path, acceptable). The open
  // itself is switch-guarded like every other open — only a dirty untitled
  // scratch prompts.
  async function reopenClosedFile() {
    for (let attempts = 0; attempts < MAX_CLOSED; attempts++) {
      const entry = takeClosed()
      if (entry === null) return
      try {
        await invoke('read_file', { path: entry.path }) // existence probe
      } catch {
        continue // file is gone (deleted/renamed since the close): skip silently
      }
      switchGuarded(() => {
        openList.update((l) => insertOpenAt(l, entry.path, entry.index))
        void openPath(entry.path)
      })
      return
    }
  }

  // Strip-row context menu semantics. 'close' routes through onCloseFile —
  // the exact close-button flow, dirty guard and active-tab revert included.
  // The bulk closes follow bulkClosePlan's documented semantics: clean
  // background rows close immediately (recorded for reopen), dirty background
  // rows are KEPT open behind one notice (no per-file prompt chain), and only
  // Close All touches the active doc — via the same guarded onCloseFile, so a
  // dirty live doc still gets its single prompt and the neighbour/empty-state
  // fallback runs as usual.
  function handleStripAction(action: StripRowAction, path: string) {
    switch (action) {
      case 'close':
        onCloseFile(path)
        break
      case 'close-others':
      case 'close-saved':
      case 'close-all': {
        const kind: BulkCloseKind =
          action === 'close-others' ? 'others' : action === 'close-saved' ? 'saved' : 'all'
        const rows = stripOrder(get(openList), get(previewPath))
        const plan = bulkClosePlan(kind, rows, path, get(doc).path, get(dirtyCached))
        for (const p of plan.close) closeBackgroundRow(p)
        if (plan.keptDirty.length > 0) {
          const n = plan.keptDirty.length
          reportNotice(
            n === 1
              ? '1 file with unsaved changes was kept open'
              : `${n} files with unsaved changes were kept open`,
          )
        }
        const active = get(doc).path
        if (plan.closeActive && active !== null) onCloseFile(active)
        break
      }
      case 'copy-path':
        // Absolute path to the system clipboard; a denied/unavailable
        // clipboard surfaces honestly rather than silently no-oping.
        navigator.clipboard
          .writeText(path)
          .catch((e) => reportError(`Could not copy path: ${String(e)}`))
        break
      case 'reveal':
        // reveal_path is allowlist-gated in Rust (AllowedPaths::ensure), so
        // only paths this window was actually granted can be revealed.
        invoke('reveal_path', { path }).catch((e) =>
          reportError(`Could not reveal file: ${String(e)}`),
        )
        break
    }
  }

  // One close-window action shared by the native close button (Rust
  // intercepts CloseRequested and emits window:close-requested) and the
  // File-menu Close Window item. Destroying the window destroys EVERY buffer
  // — the live doc and all stashed ones — so the guard prompts when any of
  // them is dirty, and the modal's Save routes to saveAllDirty (active doc
  // first, then each dirty cached buffer), only destroying once everything
  // came back clean.
  function closeThisWindow() {
    pendingPreviewPath = null
    flushBufferEdits() // see guarded(): the dirty check must not trail the editor
    // Persist the final Open Files strip BEFORE the window tears down: the
    // strip write-through is debounced, so a last-moment tab/preview/active
    // change could still be pending when destroy() kills the webview.
    flushTabWrite()
    const destroy = () => void getCurrentWindow().destroy()
    if (isDirty(get(doc)) || anyCachedDirty().length > 0) {
      openOverlay({ kind: 'discard', action: destroy, save: saveAllDirty })
    } else {
      destroy()
    }
  }

  // The in-place open for a drained startup/Finder file: switch-guarded (a
  // dirty untitled scratch still prompts; a pathed doc stashes), threading
  // each entry's own readonly flag (Finder opens keep the read-only safety
  // net, argv files open editable).
  const openStartupFile = (path: string, readonly: boolean) =>
    switchGuarded(() => openPath(path, { readonly }))

  // File > New and File > Open…, hoisted so the empty page's action rows ride
  // the EXACT same closures as the menu items (and the sidebar's "+").
  // newDoc replaces the doc without going through openPath, so the pathed
  // doc's stash is explicit here; open() stashes inside its in-place closure
  // (only once a pick actually landed).
  const newUntitled = () => switchGuarded(() => { stashActive(); newDoc() })
  const openFileDialog = () => switchGuarded(() => open())

  // Rebuild a workspace's whole Open Files strip from its persisted ui.json
  // (boot settlement or a mid-session adopt of a clean folder-less window —
  // appBoot's restoreTabsForRoot only ever calls this while the window is
  // unclaimed, so openList/previewPath are empty and nothing is clobbered).
  // The pinned rows and preview slot are set directly (never through the
  // close/reopen stack); then ONLY the active file loads — the other rows are
  // bare paths that read from disk (clean, a buffer-cache miss) on first
  // switch. At boot the doc is a pristine scratch, so handleOpenFile's switch
  // guard passes straight through. active===null (a scratch was showing over
  // the pinned rows) opens a fresh scratch; active===preview reopens it AS the
  // italic preview; otherwise the active pins in place (pinOpen is a no-op —
  // it is already among the restored tabs).
  const restoreTabs = (state: WorkspaceTabs) => {
    openList.set(state.tabs)
    previewPath.set(state.preview)
    if (state.active === null) newUntitled()
    else if (state.active === state.preview)
      handleOpenFile(state.active, { preview: true, inPlace: true })
    else handleOpenFile(state.active, { inPlace: true })
  }

  // The one gate for document-shaped actions while the empty page is shown:
  // there is no document (and no mounted editor) for them to act on, so they
  // must no-op cleanly. Gated here: save / save-as (would open a Save As
  // dialog for a doc that doesn't exist), export (same, via the menu; the
  // Header button's tick is dropped in appBoot's initExportOnTick), find /
  // find-replace / go-to-line (would open search or jump UI over a missing
  // editor), and the read-only toggle (would lock the hidden scratch and
  // render the read-only bar — its handler below also re-syncs the native
  // check mark, so it keeps its own branch). Already safe WITHOUT a gate:
  // File History (its path===null check covers the empty page's pristine
  // scratch), Close Tab (falls through to close-window — correct VS Code
  // behavior), and the Header's Split Preview toggle (a bare preference flip;
  // no editor is mounted to react, and the next open honoring it is the
  // toggle's normal meaning).
  const unlessEmpty = (fn: () => void) => () => {
    if (get(emptyState)) return
    fn()
  }

  // ⌘P Quick Open (menu item and keyboard fallback alike). Gated on a
  // workspace TREE being present, NOT on the empty page: with no folder open
  // there is nothing to list, so the palette simply doesn't open (the
  // documented no-workspace choice) — while the empty page WITH a workspace
  // is exactly where ⌘P earns its keep, as the keyboard way out of the empty
  // page. openOverlay's refusal covers every other overlay being up.
  function openQuickOpen() {
    if (get(workspace).tree === null) return
    openOverlay({ kind: 'quickopen' })
  }

  // A palette pick: close the overlay FIRST, so switchGuarded's discard
  // prompt (only a dirty untitled scratch defers — a dirty pathed doc stashes
  // into the buffer cache and switches instantly) isn't refused by the
  // palette still holding the overlay slot. Always pinned and in place: ⌘P
  // is a deliberate jump, not a glance, and must not spawn a window even
  // under openMode:'window'.
  function pickQuickOpen(path: string) {
    closeOverlay()
    handleOpenFile(path, { inPlace: true })
  }

  // menu:<id> routing table — the exact closures the hand-written menuEvents
  // map used, now keyed by bare id so the menu subscription can be DERIVED from
  // the one keymap (keymap.ts's menuItemIds). App still owns these closures
  // because they close over its stores/helpers. Each per-action guard
  // (unlessEmpty, the history/readonly/close_tab inline gates) stays INSIDE its
  // closure: menu routes deliberately gate DIFFERENTLY from the keyboard
  // fallbacks — e.g. a native Cmd+Alt+F emits menu:find_replace even behind an
  // overlay (no overlay gate), while the Cmd+Alt+F keydown fallback does gate —
  // so the two must not share the keydown driver's guard.
  const menuActions: Record<string, (payload?: Routed | null) => void> = {
    new: newUntitled,
    open: openFileDialog,
    save: unlessEmpty(() => void save()),
    save_as: unlessEmpty(() => void saveAs()),
    find: unlessEmpty(routeFind),
    find_replace: unlessEmpty(routeFindReplace),
    goto_line: unlessEmpty(() => {
      // The native Edit menu item isn't disabled by app state (menu.rs has no
      // such wiring), so it stays clickable while another overlay is up.
      // openOverlay enforces mutual exclusion at the store: it refuses (no-op)
      // if one is already open, so Go to Line can't stack its focus trap behind
      // the discard guard / Settings / History (DEFECT A1).
      openOverlay({ kind: 'goto' })
    }),
    history: () => {
      // Untitled/never-saved docs have no history — the menu item no-ops. The
      // same check already covers the empty page (its underlying scratch is
      // pathless), so no unlessEmpty gate is needed here. openOverlay handles
      // modal precedence (refuses if any overlay is open).
      if (get(doc).path === null) return
      openOverlay({ kind: 'history' })
    },
    toggle_readonly: () => {
      // The native menu item is always clickable, and muda optimistically flips
      // its check on click before this fires. Read-only isn't itself an overlay
      // (toggleReadonly may OPEN the discard guard via the dirty path), so this
      // can't lean on openOverlay's refusal — it gates on anyOverlayOpen()
      // directly, plus the empty page (no document to lock). When blocked,
      // re-sync the check to the store's real value to undo muda's optimistic
      // flip (the store didn't change, so the subscription won't).
      if (anyOverlayOpen() || get(emptyState)) {
        syncReadonlyMenu(get(doc).readonly)
        return
      }
      toggleReadonly()
    },
    // Deliberately NOT unlessEmpty-gated: Quick Open must work from the empty
    // page when a workspace exists (see openQuickOpen's own gate).
    quick_open: openQuickOpen,
    settings: () => openOverlay({ kind: 'settings' }),
    open_folder: () => openWorkspace(),
    close_folder: () => closeWorkspace(),
    open_recent: (p) => {
      const root = p?.root
      if (typeof root === 'string') void openRecentWorkspace(root)
    },
    show_log: () => revealLog(),
    close_tab: () => {
      // The Cmd+W routing rules live in closeTabDecision (appBoot.ts).
      const d = closeTabDecision(get(doc).path, get(previewPath), get(openList))
      switch (d.kind) {
        case 'close-file':
          onCloseFile(d.path)
          break
        case 'reopen-preview':
          switchGuarded(() => openPath(d.path, { preview: true }))
          break
        case 'reopen-pinned':
          switchGuarded(() => openPath(d.path))
          break
        case 'close-window':
          closeThisWindow()
          break
      }
    },
    close_window: closeThisWindow,
    export: unlessEmpty(() => void exportDocument()),
  }

  // All boot wiring (event subscriptions, startup drains, watcher/workspace
  // init, native-chrome mirrors) lives in appBoot.ts; App supplies only the
  // UI-flow closures the handlers need. The menu:<id> subscriptions are derived
  // from the keymap so the table is the single source; the two non-menu window
  // events (native close, Finder open) are added alongside.
  onMount(() => {
    const menuEvents: MenuEventMap = {
      'window:close-requested': closeThisWindow,
      'file:opened': () => void drainOpenedFiles(openStartupFile),
    }
    for (const id of menuItemIds()) {
      const action = menuActions[id]
      if (action) menuEvents[`menu:${id}`] = action
    }
    return bootApp({
      openStartupFile,
      // A workspace restore (boot settlement or a mid-session root adopt of a
      // clean folder-less window) rebuilds the whole Open Files strip and
      // lazily loads only the active file — see restoreTabs.
      restoreTabs,
      // Nothing valid remembered: a fresh untitled scratch, the exact
      // File > New closure (switch-guarded newDoc).
      openScratch: newUntitled,
      menuEvents,
    })
  })

  // Route Cmd+F by view mode: split -> CodeMirror's native search panel;
  // WYSIWYG -> the Milkdown FindBar. openSourceSearch() no-ops (returns false)
  // when no source pane is mounted, but $split already gates that.
  function routeFind() {
    if (get(split)) openSourceSearch()
    else openFind()
  }

  // Cmd+Alt+F / the "Find and Replace…" menu item: same mode-aware routing as
  // routeFind(), but split mode's CM native panel already renders replace
  // (it's hidden only when readOnly, per @codemirror/search's own panel
  // logic) so it needs no separate open call -- opening the search panel is
  // enough. WYSIWYG opens the FindBar with the replace row pre-expanded.
  function routeFindReplace() {
    if (get(split)) openSourceSearch()
    else openReplace()
  }

  // The header's Split Preview button calls toggleSplit() directly --
  // it never goes through routeFind(), which only routes *new* Cmd+F
  // invocations and does nothing for a FindBar that was already open when
  // the mode switch happens. Entering split unmounts the WYSIWYG <Editor>,
  // so a FindBar left open would render above <SplitView> as a stale,
  // permanently unresponsive overlay (see shouldForceCloseFind). Reacting
  // to $split here (rather than only inside toggleSplit/the button handler)
  // covers every control that flips split, present or future.
  $effect(() => {
    if (shouldForceCloseFind($split, $searchUi.open)) closeFind()
  })

  // Flush the outgoing editor's pending serialization BEFORE the split toggle
  // swaps the {#if $split} branches: the incoming pane seeds from
  // $doc.content, and both editors debounce, so toggling mid-typing would
  // otherwise seed the new pane up to one debounce window stale — and the
  // outgoing pane cancels its pending emission on destroy (Crepe's listener
  // and SourcePane's docSync alike), so those keystrokes would be gone for
  // good. $effect.pre runs before the DOM update, while the outgoing pane's
  // flush is still the bufferFlush registration; the doc-store write it
  // causes is picked up by the same render flush. A no-op at mount and
  // whenever nothing is pending.
  $effect.pre(() => {
    void $split
    flushBufferEdits()
  })

  // Ctrl+Tab / Ctrl+Shift+Tab / CmdOrCtrl+Shift+]/[: cycle the Open Files strip
  // in row order (see neighbourInStrip — deliberately a wrap-around cycle, not
  // VS Code's MRU picker). The target keeps its row kind: a pinned row is a
  // plain openPath (pinOpen is a no-op on an already-pinned path, the preview
  // slot untouched), the preview row re-opens AS a preview so cycling through
  // it never promotes it — pin/preview state is unchanged either way, and the
  // buffer cache makes the switch instant and lossless for dirty rows. `null`:
  // fewer than 2 rows (with the untitled scratch active, ANY row is a target —
  // neighbourInStrip enters the cycle at the first/last row).
  function cycleFiles(dir: 1 | -1) {
    const target = neighbourInStrip(get(doc).path, get(openList), get(previewPath), dir)
    if (target === null) return
    const preview = target === get(previewPath)
    switchGuarded(() => openPath(target, { preview }))
  }

  // The keyboard-fallback action for each keymap id that has a JS match. These
  // are the run() bodies moved verbatim from the old if-chain; the keymap's
  // match/guard/preventDefault flags decide WHEN each fires (see the driver
  // below). Distinct from menuActions: the keydown Find/Find-and-Replace/Go-to-
  // Line runs are UNgated here (the driver applies their overlay/empty guards),
  // whereas the menu variants wrap themselves in unlessEmpty.
  const keydownActions: Record<string, () => void> = {
    quick_open: openQuickOpen,
    reopen_closed: () => void reopenClosedFile(),
    file_cycle_next: () => cycleFiles(1),
    file_cycle_prev: () => cycleFiles(-1),
    find_replace: routeFindReplace,
    find: routeFind,
    goto_line: () => openOverlay({ kind: 'goto' }),
  }

  // Resolve a matched binding's guard against live app state — the exact
  // conditions the old if-chain used inline:
  //   'overlay'       -> Quick Open / Reopen: skip while any overlay is up.
  //   'overlay-empty' -> file cycle / Find-and-Replace / Go to Line: skip
  //                      behind an overlay OR on the empty page.
  //   'empty'         -> Find: only the empty-page gate (it deliberately claims
  //                      Cmd/Ctrl+F even while other surfaces are open).
  function keydownGuardOk(guard: KeydownGuard | undefined): boolean {
    switch (guard) {
      case 'overlay':
        return !anyOverlayOpen()
      case 'overlay-empty':
        return !anyOverlayOpen() && !get(emptyState)
      case 'empty':
        return !get(emptyState)
      default:
        return true
    }
  }

  // The window keydown driver. The one declarative keymap (keymap.ts) decides
  // WHAT matches and HOW it is guarded/claimed; this only interprets the flags:
  //
  //  - matchKeydown runs the table in order, first match wins — preserving the
  //    load-bearing precedence (Find-and-Replace before Find, so Cmd+Alt+F is
  //    never mis-claimed by the looser Find matcher on platforms where Option
  //    doesn't remap e.key).
  //  - preventDefault:'always' claims the combo BEFORE the guard check (so
  //    Cmd/Ctrl+P, Ctrl+Tab and Cmd+Shift+T/brackets never leak to the
  //    webview's print/focus-traversal/reopen defaults even when the action
  //    no-ops); 'onRun' claims it only after the guard passes (Find / Find-and-
  //    Replace / Go to Line return WITHOUT preventDefault when gated out).
  //
  // The two Escape fallbacks stay INLINE below (not in the pure table): they
  // read live $searchUi / $activeOverlay, not just the event. They sit after
  // the empty-page gate, exactly as before — closing the find bar (WYSIWYG;
  // CodeMirror owns its own panel's Esc in split mode) or the Go to Line
  // popover.
  const macPlatform = isMacPlatform()
  function handleWindowKeydown(e: KeyboardEvent) {
    const hit = matchKeydown(e, macPlatform)
    if (hit) {
      const ok = keydownGuardOk(hit.keydownGuard)
      if (hit.preventDefault === 'always') {
        e.preventDefault()
        if (!ok) return
      } else {
        if (!ok) return
        e.preventDefault()
      }
      keydownActions[hit.id]?.()
      return
    }
    // No table match. The remaining Escape fallbacks are document/editor
    // actions, so the empty page gates them out — the same gate the menu routes
    // get via unlessEmpty.
    if (get(emptyState)) return
    if (e.key === 'Escape' && $searchUi.open && $activeOverlay?.kind !== 'discard') {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'Escape' && $activeOverlay?.kind === 'goto') {
      e.preventDefault()
      clearPendingLine()
      closeOverlay()
    }
  }

  // File History revert: load the selected version into the buffer as UNSAVED
  // changes (disk truth untouched; user confirms with Cmd+S). Routed through the
  // existing discard guard so any current unsaved edits aren't silently lost, and
  // a best-effort pre-revert snapshot captures the current on-disk state first so
  // the revert is itself reversible.
  //
  // closeOverlay() runs BEFORE guarded(), unconditionally -- not after, and not
  // only on the immediate-run path. It closes the History overlay so guarded()'s
  // openOverlay({kind:'discard'}) isn't refused by History still being active
  // (mutual exclusion), leaving the discard modal as the only overlay left --
  // same as every other guarded() call site (New/Open/window-close), all
  // triggered from non-modal surfaces to begin with.
  function applyRevert(content: string) {
    closeOverlay()
    guarded(() => {
      const p = get(doc).path
      if (p) void recordRevert(p)
      revertBuffer(content)
    })
  }

  // Pull the deferred action off the discard overlay, close it, then run it.
  // Both resolutions drop any remembered deferred-preview path — the overlay
  // it described is gone either way (see pendingPreviewPath).
  function discard() {
    const o = get(activeOverlay)
    const action = o?.kind === 'discard' ? o.action : null
    pendingPreviewPath = null
    closeOverlay()
    action?.()
  }
  function cancel() {
    pendingPreviewPath = null
    closeOverlay()
    // A cancelled Read-Only toggle left $doc.readonly untouched, so the store
    // subscription won't fire — re-assert the check mark to undo muda's
    // optimistic on-click flip. Idempotent/harmless for New/Open/
    // close-cancel, where readonly didn't change either.
    syncReadonlyMenu(get(doc).readonly)
  }

  // Esc cancels the guard modal, same as clicking Cancel -- but stays inert
  // while a save is in flight (the buttons are disabled(saving) too).
  // stopPropagation keeps this from also tripping the window-level Escape
  // handler (which only acts on the find bar, and skips while the discard
  // overlay is up anyway, but this mirrors SettingsModal's pattern).
  // Only the Escape half of dialogDismissHandlers is adopted here: this modal
  // has no backdrop-click-to-close (the saving guard belongs to `cancel`, not
  // to a bare close call, so wiring onBackdropClick too would newly add a
  // dismiss path that ignores it).
  const { onKeydown: onModalKeydown } = dialogDismissHandlers(() => {
    if (!saving) cancel()
  })

  // The default Save resolution: the active doc's ordinary save(). An
  // overlay-supplied `save` (cached-tab close, window-close save-all) wins
  // when present — those flows' dirty buffers live in the buffer cache, not
  // (only) the active doc. Either way the modal only continues when the save
  // reports everything clean; a failure or cancelled Save As keeps it open so
  // no edits are silently lost.
  async function saveAndContinue() {
    saving = true
    try {
      const o = get(activeOverlay)
      const doSave =
        o?.kind === 'discard' && o.save !== undefined
          ? o.save
          : async () => {
              await save()
              return !isDirty(get(doc))
            }
      if (await doSave()) discard()
    } finally {
      saving = false
    }
  }
</script>

<!-- Suppress the WKWebView default context menu outside editable text: its only
     entry on app chrome is "Reload", which reloads the whole webview and wipes
     every in-memory store (Open Files list, unsaved buffer). Editable surfaces
     (Crepe's contenteditable, inputs) keep the native copy/paste/spellcheck menu. -->
<svelte:window
  onkeydown={handleWindowKeydown}
  oncontextmenu={(e) => {
    if (!allowsNativeContextMenu(e.target as HTMLElement | null)) e.preventDefault()
  }}
/>

<main class="app">
  <!-- Header hosts the native traffic-light overlay: nothing may render above it. -->
  <Header
    path={$imageView ?? $doc.path}
    dirty={$imageView ? false : isDirty($doc)}
    empty={$emptyState && $imageView === null}
    image={$imageView !== null}
  />
  <Banner />
  <div class="body">
    <!-- Always rendered, not gated on whether a workspace is open: Sidebar
         itself renders an empty-state panel when there's no folder yet, which
         teaches the feature and gives openWorkspace() a discoverable entry
         point beyond the File menu. -->
    <Sidebar
      activePath={$imageView ?? $doc.path}
      openFiles={$openList}
      previewPath={$previewPath}
      onOpenFile={handleOpenFile}
      onCloseFile={onCloseFile}
      onStripAction={handleStripAction}
      onNewFile={newUntitled}
      dirtyPaths={$dirtyCached}
    />
    <div class="content">
      <!-- Doc-specific chrome is gated on $imageView===null: it keys off $doc/
           $conflict/$searchUi, which still describe the backgrounded document,
           and must not bleed over the image view. -->
      {#if $doc.readonly && $imageView === null}
        <div class="readonly-bar" role="status">
          <span>🔒 Opened read-only</span>
          <button onclick={enableEditing}>Enable editing</button>
        </div>
      {/if}
      {#if $conflict !== null && $imageView === null}
        <div class="reload-bar" role="alert">
          <span>This file changed on disk. You have unsaved changes.</span>
          <div class="reload-actions">
            <button onclick={dismissConflict}>Keep mine</button>
            <button class="reload" onclick={() => reloadFromDisk($conflict!)}>Reload from disk</button>
          </div>
        </div>
      {/if}
      {#if $searchUi.open && $imageView === null}
        <FindBar />
      {/if}
      {#if $imageView !== null}
        <!-- A distinct non-editable view mode: the image overlays the editor
             area while $doc (and any unsaved buffer) stays live underneath. -->
        <ImageView path={$imageView} />
      {:else if $emptyState}
        <!-- No document at all: the empty page replaces the editor/split
             surface. Its rows call the same closures as the menu items. -->
        <EmptyState
          onNewFile={newUntitled}
          onOpenFile={openFileDialog}
          onOpenFolder={() => void openWorkspace()}
          onOpenSettings={() => openOverlay({ kind: 'settings' })}
          onOpenRecent={(root) => void openRecentWorkspace(root)}
        />
      {:else}
        {#key $doc.loadId}
          {#if $split}
            <!-- CodeMirror is byte-accurate (no adoptNormalization dance), but
                 its edits must promote a previewed doc just like the WYSIWYG
                 path's. -->
            <SplitView
              initialContent={$doc.content}
              content={$doc.content}
              readonly={$doc.readonly}
              onChange={(md) => {
                edit(md)
                promotePreviewOnEdit()
              }}
            />
          {:else}
            <Editor initialContent={$doc.content} readonly={$doc.readonly} onChange={onEditorChange} />
          {/if}
        {/key}
      {/if}
    </div>
  </div>
  <StatusBar content={$doc.content} />
</main>

{#if $activeOverlay?.kind === 'discard'}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" ondblclick={onBackdropDblClick}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      use:focusTrap
      onkeydown={onModalKeydown}
    >
      <p>You have unsaved changes. Save them before continuing?</p>
      <div class="actions">
        <button class="danger" disabled={saving} onclick={discard}>Don't Save</button>
        <button disabled={saving} data-autofocus onclick={cancel}>Cancel</button>
        <button class="primary" disabled={saving} onclick={saveAndContinue}>Save</button>
      </div>
    </div>
  </div>
{/if}

{#if $activeOverlay?.kind === 'settings'}
  <SettingsModal />
{/if}

{#if $activeOverlay?.kind === 'goto'}
  <GoToLineBar />
{/if}

{#if $activeOverlay?.kind === 'history'}
  <HistoryModal path={$doc.path} readonly={$doc.readonly} onRevert={applyRevert} />
{/if}

{#if $activeOverlay?.kind === 'quickopen'}
  <QuickOpen onPick={pickQuickOpen} />
{/if}

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  /* Sidebar + editor column sit between the header and the full-width status
     bar. min-height/width:0 lets the editor scroll instead of pushing layout. */
  .body { display: flex; flex: 1; min-height: 0; }
  .content { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .modal-backdrop {
    position: fixed; inset: 0; background: var(--backdrop);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--modal-bg); color: var(--fg); padding: 20px; border-radius: 8px;
    border: 1px solid var(--border);
    font: 14px var(--font-ui); max-width: 320px;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .actions button {
    padding: 6px 14px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid transparent;
    color: var(--fg-secondary);
    font: inherit;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
  }
  .actions button:not(:disabled):hover { background: var(--surface-hover); }
  .actions button:not(:disabled):active { background: var(--surface-active); }
  .actions button:disabled { opacity: 0.5; cursor: default; }
  .danger {
    background: transparent;
    border-color: var(--danger);
    color: var(--danger);
  }
  .danger:not(:disabled):hover { background: var(--danger-tint); }
  .danger:not(:disabled):active { background: var(--danger-tint-strong); }
  /* Solid-fill bg uses --accent-solid, not bare --accent: white (--on-accent)
     text on --accent is only 3.31:1, below WCAG AA 4.5:1 for normal text;
     --accent-solid and its hover/active shades clear 4.5:1+ in both themes. */
  .primary {
    background: var(--accent-solid);
    border-color: transparent;
    color: var(--on-accent);
    font-weight: 600;
  }
  .primary:not(:disabled):hover { background: var(--accent-solid-hover); }
  .primary:not(:disabled):active { background: var(--accent-solid-active); }

  .reload-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: var(--warn-bg);
    color: var(--warn-fg);
    font: 13px var(--font-ui);
    border-bottom: 1px solid var(--warn-border);
  }
  .reload-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .reload-bar button {
    font: inherit;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: var(--surface);
    color: var(--fg-secondary);
    transition: background-color 0.1s ease;
  }
  .reload-bar button:hover { background: var(--surface-hover); }
  .reload-bar button:active { background: var(--surface-active); }
  /* --accent-solid, not bare --accent: see .primary comment above. */
  .reload-bar .reload {
    font-weight: 600;
    background: var(--accent-solid);
    color: var(--on-accent);
  }
  .reload-bar .reload:hover { background: var(--accent-solid-hover); }
  .reload-bar .reload:active { background: var(--accent-solid-active); }

  .readonly-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: var(--info-bg);
    color: var(--info-fg);
    font: 13px var(--font-ui);
    border-bottom: 1px solid var(--info-border);
  }
  /* --accent-solid, not bare --accent: see .primary comment above. */
  .readonly-bar button {
    font: inherit;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid transparent;
    font-weight: 600;
    background: var(--accent-solid);
    color: var(--on-accent);
    transition: background-color 0.1s ease;
  }
  .readonly-bar button:hover { background: var(--accent-solid-hover); }
  .readonly-bar button:active { background: var(--accent-solid-active); }
</style>
