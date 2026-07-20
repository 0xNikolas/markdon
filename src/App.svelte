<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { get } from 'svelte/store'
  import { doc, edit, newDoc, isDirty, enableEditing } from './lib/doc'
  import { open, save, saveAs, openPath } from './lib/files'
  import { conflict, reloadFromDisk, dismissConflict, initFileSync } from './lib/fileSync'
  import Editor from './Editor.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'
  import FindBar from './FindBar.svelte'
  import { searchUi, openFind, closeFind } from './lib/searchPlugin'

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
      listen('menu:find', () => openFind()),
      listen('window:close-requested', () => guarded(() => getCurrentWindow().destroy())),
      listen('file:opened', () => drainOpenedFiles()),
    ])
    drainOpenedFiles() // cold launch: pick up the file the app was opened with
    const teardownSync = initFileSync() // watch the open file for external changes
    return () => {
      unsub.then((fns) => fns.forEach((f) => f()))
      teardownSync.then((fn) => fn())
    }
  })

  // Esc closes the find bar even when focus is inside the editor (FindBar's
  // own onkeydown only sees Esc while its input is focused). Also a
  // Cmd/Ctrl+F fallback for platforms where the native menu accelerator
  // (src-tauri/src/menu.rs) doesn't reach the webview -- a no-op if the
  // menu already handled it, since openFind() is idempotent while open.
  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && $searchUi.open && pendingAction === null) {
      e.preventDefault()
      closeFind()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFind()
    }
  }

  function discard() {
    const action = pendingAction
    pendingAction = null
    action?.()
  }
  function cancel() { pendingAction = null }
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
  <Banner />
  {#if $doc.readonly}
    <div class="readonly-bar" role="status">
      <span>🔒 Opened read-only</span>
      <button class="primary" onclick={enableEditing}>Enable editing</button>
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
    <Editor initialContent={$doc.content} readonly={$doc.readonly} onChange={edit} />
  {/key}
  <StatusBar path={$doc.path} dirty={isDirty($doc)} content={$doc.content} />
</main>

{#if pendingAction}
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <p>You have unsaved changes. Save them before continuing?</p>
      <div class="actions">
        <button class="danger" disabled={saving} onclick={discard}>Don't Save</button>
        <button disabled={saving} onclick={cancel}>Cancel</button>
        <button class="primary" disabled={saving} onclick={saveAndContinue}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  .modal-backdrop {
    position: fixed; inset: 0; background: var(--backdrop);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--modal-bg); color: var(--fg); padding: 20px; border-radius: 8px;
    font: 14px system-ui, sans-serif; max-width: 320px;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .danger { color: var(--danger); }
  .primary { font-weight: 600; }

  .reload-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: var(--warn-bg);
    color: var(--warn-fg);
    font: 13px system-ui, sans-serif;
    border-bottom: 1px solid var(--warn-border);
  }
  .reload-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .reload-bar button { font: inherit; cursor: pointer; }
  .reload-bar .reload { font-weight: 600; }

  .readonly-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: var(--info-bg);
    color: var(--info-fg);
    font: 13px system-ui, sans-serif;
    border-bottom: 1px solid var(--info-border);
  }
  .readonly-bar button { font: inherit; cursor: pointer; }
</style>
