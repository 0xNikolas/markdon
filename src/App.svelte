<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { document, edit, newDoc } from './lib/document'
  import { open, save, saveAs } from './lib/files'
  import Editor from './Editor.svelte'
  import StatusBar from './StatusBar.svelte'

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => newDoc()),
      listen('menu:open', () => open()),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
    ])
    return () => { unsub.then((fns) => fns.forEach((f) => f())) }
  })
</script>

<main class="app">
  {#key $document.loadId}
    <Editor initialContent={$document.content} onChange={edit} />
  {/key}
  <StatusBar path={$document.path} dirty={$document.dirty} content={$document.content} />
</main>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
</style>
