<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { get } from 'svelte/store'
  import { doc, edit, newDoc, isDirty, enableEditing } from './lib/doc'
  import { open, save, saveAs, openPath, openInPreferredTarget } from './lib/files'
  import { openList, removeOpen, neighbourAfterClose } from './lib/openList'
  import { conflict, reloadFromDisk, dismissConflict, initFileSync } from './lib/fileSync'
  import Editor from './Editor.svelte'
  import SplitView from './SplitView.svelte'
  import Header from './Header.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'
  import FindBar from './FindBar.svelte'
  import SettingsModal from './SettingsModal.svelte'
  import GoToLineBar from './GoToLineBar.svelte'
  import Sidebar from './Sidebar.svelte'
  import { searchUi, openFind, closeFind, shouldForceCloseFind } from './lib/searchPlugin'
  import { openSourceSearch, clearPendingLine } from './lib/sourceEditor'
  import {
    settingsOpen,
    openSettings,
    gotoOpen,
    openGoto,
    closeGoto,
    split,
    exportTick,
    isMacPlatform,
    isGotoLineFallbackKey,
  } from './lib/ui'
  import { openWorkspace, initWorkspace } from './lib/workspace'
  import { exportDocument } from './lib/export'
  import { focusTrap } from './lib/focusTrap'

  // Action to run if the user chooses to discard unsaved changes. When set, the
  // confirm modal is shown. Guards New, Open, and window close uniformly.
  let pendingAction = $state<(() => void) | null>(null)

  // True while `save()` is in flight (native dialogs aren't window-parented,
  // so the modal stays clickable underneath them without this guard).
  let saving = $state(false)

  // Run `action` immediately if the document is clean; otherwise defer it behind
  // the discard-confirm modal so unsaved edits are never silently lost.
  function guarded(action: () => void) {
    if (isDirty(get(doc))) pendingAction = action
    else action()
  }

  // Single entry point for opening a path from the sidebar (Open Files strip
  // or Workspace tree alike) -- routes through openInPreferredTarget (task
  // 21's tab/window choke-point; Stage 1 always opens in-place) wrapping the
  // existing guarded openPath. A click on the already-active row is a no-op.
  function handleOpenFile(path: string) {
    if (path === get(doc).path) return
    openInPreferredTarget(path, (p) => guarded(() => openPath(p)))
  }

  // Sidebar Open Files close affordance. A non-active entry can never be
  // dirty (switching away from a file always resolves the dirty-guard
  // first), so closing it is a bare list removal. Closing the active entry
  // still runs the guard, then switches to the neighbour computed BEFORE
  // removal (previous, else next, else null -> falls back to newDoc()).
  function onCloseFile(path: string) {
    if (path !== get(doc).path) {
      openList.update((l) => removeOpen(l, path))
      return
    }
    guarded(() => {
      const next = neighbourAfterClose(get(openList), path, get(doc).path)
      openList.update((l) => removeOpen(l, path))
      if (next === null) newDoc()
      else openPath(next)
    })
  }

  // Open a file the OS handed us via a .md file association (Finder double-click).
  // Drains the Rust-side buffer; opens the first path through the same guard as
  // File → Open. Called on mount (cold launch) and on each `file:opened` ping.
  async function drainOpenedFiles() {
    const paths = await invoke<string[]>('take_opened_files')
    if (paths.length > 0) guarded(() => openPath(paths[0], true))
  }

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => guarded(() => newDoc())),
      listen('menu:open', () => guarded(() => open())),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
      listen('menu:find', () => routeFind()),
      listen('menu:goto_line', () => {
        // Same gating as the Cmd+L keydown fallback below: the native Edit
        // menu item isn't disabled by app state (menu.rs has no such wiring),
        // so without this the item stays clickable while the discard-guard
        // modal or Settings is open, stacking GoToLineBar's focus trap behind
        // them and, on close, stripping `inert` out from under the modal
        // that's still open (focusTrap.destroy() unconditionally clears it).
        if (pendingAction !== null || get(settingsOpen) || get(gotoOpen)) return
        openGoto()
      }),
      listen('menu:settings', () => openSettings()),
      listen('menu:open_folder', () => openWorkspace()),
      listen('menu:export', () => exportDocument()),
      listen('window:close-requested', () => guarded(() => getCurrentWindow().destroy())),
      listen('file:opened', () => drainOpenedFiles()),
    ])
    drainOpenedFiles() // cold launch: pick up the file the app was opened with
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
    return () => {
      unsub.then((fns) => fns.forEach((f) => f()))
      teardownSync.then((fn) => fn())
      teardownWorkspace.then((fn) => fn())
      unsubExportTick()
    }
  })

  // Route Cmd+F by view mode: split -> CodeMirror's native search panel;
  // WYSIWYG -> the Milkdown FindBar. openSourceSearch() no-ops (returns false)
  // when no source pane is mounted, but $split already gates that.
  function routeFind() {
    if (get(split)) openSourceSearch()
    else openFind()
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
  // fallback above, this one explicitly skips while another modal/overlay
  // is already up (pendingAction, Settings, or the popover itself) so it
  // can't double-open or steal focus from a higher-priority surface.
  const macPlatform = isMacPlatform()
  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && $searchUi.open && pendingAction === null) {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'Escape' && $gotoOpen) {
      e.preventDefault()
      clearPendingLine()
      closeGoto()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      routeFind()
    } else if (isGotoLineFallbackKey(e, macPlatform)) {
      if (pendingAction !== null || $settingsOpen || $gotoOpen) return
      e.preventDefault()
      openGoto()
    }
  }

  function discard() {
    const action = pendingAction
    pendingAction = null
    action?.()
  }
  function cancel() { pendingAction = null }

  // Esc cancels the guard modal, same as clicking Cancel -- but stays inert
  // while a save is in flight (the buttons are disabled(saving) too).
  // stopPropagation keeps this from also tripping the window-level Escape
  // handler (which only acts on the find bar, and is gated on
  // pendingAction === null anyway, but this mirrors SettingsModal's pattern).
  function onModalKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (!saving) cancel()
  }

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

<svelte:window onkeydown={handleWindowKeydown} />

<main class="app">
  <!-- Header hosts the native traffic-light overlay: nothing may render above it. -->
  <Header path={$doc.path} dirty={isDirty($doc)} />
  <Banner />
  <div class="body">
    <!-- Always rendered, not gated on whether a workspace is open: Sidebar
         itself renders an empty-state panel when there's no folder yet, which
         teaches the feature and gives openWorkspace() a discoverable entry
         point beyond the File menu (sidebar-fix, task 12). -->
    <Sidebar
      activePath={$doc.path}
      openFiles={$openList}
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
          <SplitView
            initialContent={$doc.content}
            content={$doc.content}
            readonly={$doc.readonly}
            onChange={edit}
          />
        {:else}
          <Editor initialContent={$doc.content} readonly={$doc.readonly} onChange={edit} />
        {/if}
      {/key}
    </div>
  </div>
  <StatusBar content={$doc.content} />
</main>

{#if pendingAction}
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

{#if $settingsOpen}
  <SettingsModal />
{/if}

{#if $gotoOpen}
  <GoToLineBar />
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
