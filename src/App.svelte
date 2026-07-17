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

  let confirmClose = $state(false)

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => newDoc()),
      listen('menu:open', () => open()),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
      listen('window:close-requested', () => {
        if (get(document).dirty) confirmClose = true
        else getCurrentWindow().destroy()
      }),
    ])
    return () => { unsub.then((fns) => fns.forEach((f) => f())) }
  })

  function discardAndClose() { getCurrentWindow().destroy() }
  function cancelClose() { confirmClose = false }
</script>

<main class="app">
  <Banner />
  {#key $document.loadId}
    <Editor initialContent={$document.content} onChange={edit} />
  {/key}
  <StatusBar path={$document.path} dirty={$document.dirty} content={$document.content} />
</main>

{#if confirmClose}
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <p>You have unsaved changes. Discard them and close?</p>
      <div class="actions">
        <button onclick={cancelClose}>Cancel</button>
        <button class="danger" onclick={discardAndClose}>Discard & Close</button>
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
