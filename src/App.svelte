<script lang="ts">
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
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
    neighbourAfterClose,
  } from './lib/openList'
  import { conflict, reloadFromDisk, dismissConflict } from './lib/fileSync'
  import {
    bootApp,
    closeTabDecision,
    drainOpenedFiles,
    syncReadonlyMenu,
  } from './lib/appBoot'
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
    isMacPlatform,
    isGotoLineFallbackKey,
    isFindReplaceFallbackKey,
  } from './lib/ui'
  import { activeOverlay, openOverlay, closeOverlay, anyOverlayOpen } from './lib/overlay'
  import { openWorkspace, openRecentWorkspace, closeWorkspace } from './lib/workspace'
  import { revealLog } from './lib/errors'
  import { exportDocument } from './lib/export'
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
  // never in openList, but it RENDERS as the last row (after every pinned
  // one), so closing an active preview appends it for the lookup — its
  // visual previous neighbour is the last pinned entry, not a blank new doc.
  // Clearing state inside the guard keeps Cancel non-destructive.
  function onCloseFile(path: string) {
    if (path !== get(doc).path) {
      const closeBackground = () => {
        if (path === get(previewPath)) previewPath.set(null)
        else openList.update((l) => removeOpen(l, path))
        evict(path)
      }
      if (isCachedDirty(path)) {
        pendingPreviewPath = null
        openOverlay({
          kind: 'discard',
          action: closeBackground,
          save: () => saveCachedBuffer(path),
        })
      } else {
        closeBackground()
      }
      return
    }
    guarded(() => {
      const list = get(openList)
      const lookup = path === get(previewPath) ? [...list, path] : list
      const next = neighbourAfterClose(lookup, path, get(doc).path)
      previewPath.update((pv) => (pv === path ? null : pv))
      openList.update((l) => removeOpen(l, path))
      evict(path) // close destroys: drop any (defensive) cache entry with the row
      if (next === null) newDoc()
      else openPath(next)
    })
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

  // All boot wiring (event subscriptions, startup drains, watcher/workspace
  // init, native-chrome mirrors) lives in appBoot.ts; App supplies only the
  // UI-flow closures the handlers need.
  onMount(() =>
    bootApp({
      openStartupFile,
      menuEvents: {
        // newDoc replaces the doc without going through openPath, so the
        // pathed doc's stash is explicit here; open() stashes inside its
        // in-place closure (only once a pick actually landed).
        'menu:new': () => switchGuarded(() => { stashActive(); newDoc() }),
        'menu:open': () => switchGuarded(() => open()),
        'menu:save': () => save(),
        'menu:save_as': () => saveAs(),
        'menu:find': () => routeFind(),
        'menu:find_replace': () => routeFindReplace(),
        'menu:goto_line': () => {
          // The native Edit menu item isn't disabled by app state (menu.rs has
          // no such wiring), so it stays clickable while another overlay is up.
          // openOverlay enforces mutual exclusion at the store: it refuses (no-op)
          // if one is already open, so Go to Line can't stack its focus trap
          // behind the discard guard / Settings / History (DEFECT A1).
          openOverlay({ kind: 'goto' })
        },
        'menu:history': () => {
          // Untitled/never-saved docs have no history — the menu item no-ops.
          // openOverlay handles modal precedence (refuses if any overlay is open).
          if (get(doc).path === null) return
          openOverlay({ kind: 'history' })
        },
        'menu:toggle_readonly': () => {
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
        },
        'menu:settings': () => openOverlay({ kind: 'settings' }),
        'menu:open_folder': () => openWorkspace(),
        'menu:close_folder': () => closeWorkspace(),
        'menu:open_recent': (p) => {
          const root = p?.root
          if (typeof root === 'string') void openRecentWorkspace(root)
        },
        'menu:show_log': () => revealLog(),
        'menu:close_tab': () => {
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
        'menu:close_window': closeThisWindow,
        'menu:export': () => exportDocument(),
        'window:close-requested': closeThisWindow,
        'file:opened': () => void drainOpenedFiles(openStartupFile),
      },
    }),
  )

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
      onNewFile={() => switchGuarded(() => { stashActive(); newDoc() })}
      dirtyPaths={$dirtyCached}
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
