<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { listenScoped } from './lib/windowing'
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
  } from './lib/doc'
  import { recordRevert } from './lib/history'
  import { open, save, saveAs, openPath, openInPreferredTarget } from './lib/files'
  import {
    openList,
    previewPath,
    pinOpen,
    pinPreview,
    removeOpen,
    neighbourAfterClose,
  } from './lib/openList'
  import { conflict, reloadFromDisk, dismissConflict, initFileSync } from './lib/fileSync'
  import { reportError } from './lib/errors'
  import { allowsNativeContextMenu } from './lib/contextMenu'
  import Editor from './Editor.svelte'
  import SplitView from './SplitView.svelte'
  import Header from './Header.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'
  import FindBar from './FindBar.svelte'
  import SettingsModal from './SettingsModal.svelte'
  import GoToLineBar from './GoToLineBar.svelte'
  import HistoryModal from './HistoryModal.svelte'
  import Sidebar from './Sidebar.svelte'
  import { searchUi, openFind, openReplace, closeFind, shouldForceCloseFind } from './lib/searchPlugin'
  import { openSourceSearch, clearPendingLine } from './lib/sourceEditor'
  import {
    split,
    exportTick,
    isMacPlatform,
    isGotoLineFallbackKey,
    isFindReplaceFallbackKey,
  } from './lib/ui'
  import { activeOverlay, openOverlay, closeOverlay, anyOverlayOpen } from './lib/overlay'
  import { openWorkspace, closeWorkspace, initWorkspace } from './lib/workspace'
  import { exportDocument } from './lib/export'
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'

  // True while `save()` is in flight (native dialogs aren't window-parented,
  // so the modal stays clickable underneath them without this guard).
  let saving = $state(false)

  // Run `action` immediately if the document is clean; otherwise defer it behind
  // the discard-confirm modal (the 'discard' overlay) so unsaved edits are never
  // silently lost. Guards New, Open, and window close uniformly. openOverlay
  // refuses if any overlay is already up: for the gated menu paths (goto,
  // history, readonly) that can't happen, and for the ungated ones (Cmd+N,
  // Cmd+O, window close while e.g. Settings is open on a dirty doc) the action
  // deliberately no-ops — the buffer is left untouched, which is the safe
  // replacement for the old behavior of stacking the discard modal invisibly
  // behind the open overlay.
  function guarded(action: () => void) {
    if (isDirty(get(doc))) openOverlay({ kind: 'discard', action })
    else action()
  }

  // Push the read-only flag to the native File-menu "Read Only" check mark.
  // The doc store is the single source of truth: Finder read-only
  // opens, the banner's "Enable editing" button, and the manual toggle all
  // change $doc.readonly, and the onMount subscription funnels every change
  // through here. Also called directly when a toggle is refused/cancelled, to
  // undo muda's optimistic on-click flip (macOS flips the check before the
  // event reaches us; if the store didn't actually change, the subscription
  // won't fire, so we re-assert the real value). Menu-sync failure is
  // non-fatal — the check mark is cosmetic — so errors are swallowed.
  function syncReadonlyMenu(checked: boolean): void {
    void invoke('set_readonly_menu_state', { checked }).catch(() => {})
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

  // Single entry point for opening a path from the sidebar (Open Files strip
  // or Workspace tree alike). A single click asks for a PREVIEW: always
  // in-place regardless of openMode (a glance must never spawn a window),
  // parked in the italic preview slot by openPath. A pinned open routes
  // through openInPreferredTarget (the tab/window choke-point) unless
  // `inPlace` forces this window — that is what the explicit "Open in New
  // Tab" action means even under openMode:'window'. Re-activating the
  // already-active doc without `preview` pins it: that is exactly the
  // dblclick arriving after its own first click already previewed the file.
  function handleOpenFile(path: string, opts: { preview?: boolean; inPlace?: boolean } = {}) {
    if (path === get(doc).path) {
      if (!opts.preview) pinOpen(path)
      return
    }
    if (opts.preview) {
      guarded(() => openPath(path, { preview: true }))
      return
    }
    if (opts.inPlace) {
      guarded(() => openPath(path))
      return
    }
    openInPreferredTarget(path, (p) => guarded(() => openPath(p)))
  }

  // Sidebar Open Files close affordance. A non-active entry can never be
  // dirty (switching away from a file always resolves the dirty-guard
  // first), so closing it is a bare removal — from the pinned list, or by
  // vacating the preview slot (the two are mutually exclusive by openPath's
  // invariant). Closing the active entry (pinned or preview — a preview is a
  // normal live doc) still runs the guard, then switches to the neighbour
  // computed BEFORE removal (previous, else next, else null -> falls back to
  // newDoc()). The preview path is never in openList, so the neighbour logic
  // runs on the pinned list as-is; clearing state inside the guard keeps
  // Cancel non-destructive.
  function onCloseFile(path: string) {
    if (path !== get(doc).path) {
      if (path === get(previewPath)) previewPath.set(null)
      else openList.update((l) => removeOpen(l, path))
      return
    }
    guarded(() => {
      const next = neighbourAfterClose(get(openList), path, get(doc).path)
      previewPath.update((pv) => (pv === path ? null : pv))
      openList.update((l) => removeOpen(l, path))
      if (next === null) newDoc()
      else openPath(next)
    })
  }

  // Open a file the OS handed us via a .md file association (Finder double-click).
  // Drains the Rust-side buffer and routes the first path through the openMode
  // preference: MODE A opens it in-place (guarded, read-only like before); MODE
  // B spawns a fresh window for it, leaving this (focused) window's doc alone.
  // Called on mount (cold launch) and on each `file:opened` ping.
  async function drainOpenedFiles() {
    const paths = await invoke<string[]>('take_opened_files')
    // readonly=true in BOTH modes: in-place opens pass it to openPath directly,
    // and MODE B carries it through the window hand-off (AssignedFile.readonly)
    // so the spawned window keeps the same Finder-open safety net.
    if (paths.length > 0)
      openInPreferredTarget(paths[0], (p) => guarded(() => openPath(p, { readonly: true })), true)
  }

  // A spawned document window (doc-N) drains the file it was created to host
  // (set by open_document_window). Drains exactly once — a re-mount gets None.
  // The label is derived Rust-side from the Tauri-injected WebviewWindow (not
  // passed by the caller), so a window can only ever drain its OWN hand-off --
  // see take_window_file in lib.rs. Returns whether a file was actually
  // assigned, so onMount can decide whether this window also needs to drain
  // the unrelated, process-global OpenedFiles queue (it must not, see below).
  // A drain failure is surfaced via the error banner (reportError convention)
  // and treated as "no assignment" so the window still falls back to the
  // global queue rather than silently sitting on a blank untitled doc.
  async function takeAssignedFile(): Promise<boolean> {
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

  // One close-window action shared by the native close button (Rust
  // intercepts CloseRequested and emits window:close-requested) and the
  // File-menu Close Window item — both must resolve the dirty guard before
  // the window is destroyed.
  const closeThisWindow = () => guarded(() => getCurrentWindow().destroy())

  onMount(() => {
    const unsub = Promise.all([
      listenScoped('menu:new', () => guarded(() => newDoc())),
      listenScoped('menu:open', () => guarded(() => open())),
      listenScoped('menu:save', () => save()),
      listenScoped('menu:save_as', () => saveAs()),
      listenScoped('menu:find', () => routeFind()),
      listenScoped('menu:find_replace', () => routeFindReplace()),
      listenScoped('menu:goto_line', () => {
        // The native Edit menu item isn't disabled by app state (menu.rs has
        // no such wiring), so it stays clickable while another overlay is up.
        // openOverlay enforces mutual exclusion at the store: it refuses (no-op)
        // if one is already open, so Go to Line can't stack its focus trap
        // behind the discard guard / Settings / History (DEFECT A1).
        openOverlay({ kind: 'goto' })
      }),
      listenScoped('menu:history', () => {
        // Untitled/never-saved docs have no history — the menu item no-ops.
        // openOverlay handles modal precedence (refuses if any overlay is open).
        if (get(doc).path === null) return
        openOverlay({ kind: 'history' })
      }),
      listenScoped('menu:toggle_readonly', () => {
        // The native menu item is always clickable, and muda optimistically
        // flips its check on click before this fires. Read-only isn't itself an
        // overlay (toggleReadonly may OPEN the discard guard via the dirty
        // path), so this can't lean on openOverlay's refusal — it gates on
        // anyOverlayOpen() directly. When blocked, re-sync the check to the
        // store's real value to undo muda's optimistic flip (the store didn't
        // change, so the subscription won't).
        if (anyOverlayOpen()) {
          syncReadonlyMenu(get(doc).readonly)
          return
        }
        toggleReadonly()
      }),
      listenScoped('menu:settings', () => openOverlay({ kind: 'settings' })),
      listenScoped('menu:open_folder', () => openWorkspace()),
      listenScoped('menu:close_folder', () => closeWorkspace()),
      listenScoped('menu:close_tab', () => {
        // Cmd+W closes the active entry (pinned or preview) through the same
        // onCloseFile path as the strip's close button; with no file open
        // (untitled doc) it falls through to closing the window — VS Code
        // behavior.
        const p = get(doc).path
        if (p !== null) onCloseFile(p)
        else closeThisWindow()
      }),
      listenScoped('menu:close_window', closeThisWindow),
      listenScoped('menu:export', () => exportDocument()),
      listenScoped('window:close-requested', closeThisWindow),
      listenScoped('file:opened', () => drainOpenedFiles()),
    ])
    // A spawned doc-N window (MODE B) is created to host exactly one file,
    // handed off via PendingWindowFile; it must never ALSO race to drain the
    // unrelated, process-global OpenedFiles queue (that queue belongs to
    // whichever window is focused at Finder-open time). Running both calls
    // unawaited let a freshly-spawned window steal a Finder-open meant for a
    // different window, or let the two hand-offs clobber each other with no
    // error surfaced. Awaiting the per-window
    // hand-off FIRST, and only falling back to the global drain when this
    // window has no assignment of its own, makes the two mutually exclusive
    // instead of concurrent.
    void (async () => {
      const hadAssignedFile = await takeAssignedFile()
      if (!hadAssignedFile) await drainOpenedFiles() // cold launch / main window: pick up the file the app was opened with
    })()
    const teardownSync = initFileSync() // watch the open file for external changes
    const teardownWorkspace = initWorkspace() // restore + refresh the workspace tree
    // Header's Export button increments exportTick rather than calling
    // exportDocument() directly (ui.ts's requestExport contract) -- skip the
    // subscribe's immediate replay of the current value so mounting doesn't
    // trigger a spurious export.
    let firstExportTick = true
    const unsubExportTick = exportTick.subscribe(() => {
      if (firstExportTick) {
        firstExportTick = false
        return
      }
      exportDocument()
    })
    // Mirror $doc.readonly onto the native "Read Only" check mark.
    // Fires on mount (seeding the check to the current state) and on every
    // readonly transition; gated on the flag actually changing so ordinary
    // keystroke-driven store updates don't spam the IPC bridge.
    let lastReadonly: boolean | null = null
    const unsubReadonlyMenu = doc.subscribe((s) => {
      if (s.readonly === lastReadonly) return
      lastReadonly = s.readonly
      syncReadonlyMenu(s.readonly)
    })
    return () => {
      unsub.then((fns) => fns.forEach((f) => f()))
      teardownSync.then((fn) => fn())
      teardownWorkspace.then((fn) => fn())
      unsubExportTick()
      unsubReadonlyMenu()
    }
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

  // Esc closes the find bar even when focus is inside the editor (FindBar's
  // own onkeydown only sees Esc while its input is focused). Also a
  // Cmd/Ctrl+F fallback for platforms where the native menu accelerator
  // (src-tauri/src/menu.rs) doesn't reach the webview -- a no-op if the
  // menu already handled it, since the find command is idempotent while open.
  // In split mode CodeMirror owns its panel's Esc, so we only close the
  // FindBar here (WYSIWYG).
  //
  // Go to Line's fallback is gated per-platform (isGotoLineFallbackKey):
  // on mac it's metaKey-ONLY, NEVER ctrlKey too, since @codemirror/commands
  // binds mac:'Ctrl-l' to selectLine and treating Ctrl+L as Go to Line in
  // split mode would fight CM's own binding; everywhere else CmdOrCtrl+L IS
  // Ctrl+L and CM's non-mac selectLine binding is Alt-L (no collision), so
  // ctrlKey is honored there too -- otherwise the fallback would be
  // unreachable by keyboard on Windows/Linux. Unlike the ungated Cmd+F
  // fallback above, this one skips while any overlay is already up
  // (anyOverlayOpen(): the discard guard, Settings, History, or the popover
  // itself) so it can't double-open or steal focus from a higher-priority
  // surface.
  //
  // Find and Replace's fallback (isFindReplaceFallbackKey) is checked BEFORE
  // the plain Cmd+F branch and gated the same way as Go to Line: it must run
  // first because Cmd+Alt+F would otherwise also satisfy the looser Cmd+F
  // test below on platforms where Option doesn't remap `e.key` (see
  // isFindReplaceFallbackKey's doc comment on why it checks e.code instead).
  const macPlatform = isMacPlatform()
  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && $searchUi.open && $activeOverlay?.kind !== 'discard') {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'Escape' && $activeOverlay?.kind === 'goto') {
      e.preventDefault()
      clearPendingLine()
      closeOverlay()
    } else if (isFindReplaceFallbackKey(e)) {
      if (anyOverlayOpen()) return
      e.preventDefault()
      routeFindReplace()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      routeFind()
    } else if (isGotoLineFallbackKey(e, macPlatform)) {
      if (anyOverlayOpen()) return
      e.preventDefault()
      openOverlay({ kind: 'goto' })
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
  function discard() {
    const o = get(activeOverlay)
    const action = o?.kind === 'discard' ? o.action : null
    closeOverlay()
    action?.()
  }
  function cancel() {
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

  async function saveAndContinue() {
    saving = true
    try {
      await save()
      // If the save failed or Save As was cancelled the doc is still dirty:
      // keep the modal open so no edits are silently lost.
      if (!isDirty(get(doc))) discard()
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
  <Header path={$doc.path} dirty={isDirty($doc)} />
  <Banner />
  <div class="body">
    <!-- Always rendered, not gated on whether a workspace is open: Sidebar
         itself renders an empty-state panel when there's no folder yet, which
         teaches the feature and gives openWorkspace() a discoverable entry
         point beyond the File menu. -->
    <Sidebar
      activePath={$doc.path}
      openFiles={$openList}
      previewPath={$previewPath}
      onOpenFile={handleOpenFile}
      onCloseFile={onCloseFile}
      onNewFile={() => guarded(() => newDoc())}
    />
    <div class="content">
      {#if $doc.readonly}
        <div class="readonly-bar" role="status">
          <span>🔒 Opened read-only</span>
          <button onclick={enableEditing}>Enable editing</button>
        </div>
      {/if}
      {#if $conflict !== null}
        <div class="reload-bar" role="alert">
          <span>This file changed on disk. You have unsaved changes.</span>
          <div class="reload-actions">
            <button onclick={dismissConflict}>Keep mine</button>
            <button class="reload" onclick={() => reloadFromDisk($conflict!)}>Reload from disk</button>
          </div>
        </div>
      {/if}
      {#if $searchUi.open}
        <FindBar />
      {/if}
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
    </div>
  </div>
  <StatusBar content={$doc.content} />
</main>

{#if $activeOverlay?.kind === 'discard'}
  <div class="modal-backdrop">
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
