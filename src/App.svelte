<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { invoke } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { get } from 'svelte/store'
  import { document, edit, newDoc } from './lib/document'
  import { open, save, saveAs, openPath } from './lib/files'
  import { conflict, reloadFromDisk, dismissConflict, initFileSync } from './lib/fileSync'
  import Editor from './Editor.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'

  // Action to run if the user chooses to discard unsaved changes. When set, the
  // confirm modal is shown. Guards New, Open, and window close uniformly.
  let pendingAction = $state<(() => void) | null>(null)

  // Run `action` immediately if the document is clean; otherwise defer it behind
  // the discard-confirm modal so unsaved edits are never silently lost.
  function guarded(action: () => void) {
    if (get(document).dirty) pendingAction = action
    else action()
  }

  // Open a file the OS handed us via a .md file association (Finder double-click).
  // Drains the Rust-side buffer; opens the first path through the same guard as
  // File → Open. Called on mount (cold launch) and on each `file:opened` ping.
  async function drainOpenedFiles() {
    const paths = await invoke<string[]>('take_opened_files')
    if (paths.length > 0) guarded(() => openPath(paths[0]))
  }

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => guarded(() => newDoc())),
      listen('menu:open', () => guarded(() => open())),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
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

  function discard() {
    const action = pendingAction
    pendingAction = null
    action?.()
  }
  function cancel() { pendingAction = null }
</script>

<main class="app">
  <Banner />
  {#if $conflict !== null}
    <div class="reload-bar" role="alert">
      <span>This file changed on disk. You have unsaved changes.</span>
      <div class="reload-actions">
        <button onclick={dismissConflict}>Keep mine</button>
        <button class="reload" onclick={() => reloadFromDisk($conflict!)}>Reload from disk</button>
      </div>
    </div>
  {/if}
  {#key $document.loadId}
    <Editor initialContent={$document.content} onChange={edit} />
  {/key}
  <StatusBar path={$document.path} dirty={$document.dirty} content={$document.content} />
</main>

{#if pendingAction}
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <p>You have unsaved changes. Discard them and continue?</p>
      <div class="actions">
        <button onclick={cancel}>Cancel</button>
        <button class="danger" onclick={discard}>Discard &amp; Continue</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #fff; padding: 20px; border-radius: 8px;
    font: 14px system-ui, sans-serif; max-width: 320px;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .danger { color: #b3261e; }

  .reload-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    background: #fff8e1;
    color: #5f4b00;
    font: 13px system-ui, sans-serif;
    border-bottom: 1px solid #f0e0a0;
  }
  .reload-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .reload-bar button { font: inherit; cursor: pointer; }
  .reload-bar .reload { font-weight: 600; }
</style>
