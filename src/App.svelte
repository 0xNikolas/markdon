<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { get } from 'svelte/store'
  import { document, edit, newDoc } from './lib/document'
  import { open, save, saveAs } from './lib/files'
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

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => guarded(() => newDoc())),
      listen('menu:open', () => guarded(() => open())),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
      listen('window:close-requested', () => guarded(() => getCurrentWindow().destroy())),
    ])
    return () => { unsub.then((fns) => fns.forEach((f) => f())) }
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
</style>
