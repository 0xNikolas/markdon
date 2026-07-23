<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core'

  interface Props {
    /** Absolute path of the image to view. */
    path: string
  }
  let { path }: Props = $props()

  // Pure URL build (asset://), no IPC: the recursive workspace asset grant
  // already authorizes any path inside the open root — the only source of an
  // image click — so convertFileSrc renders the file directly.
  let src = $derived(convertFileSrc(path))

  // The asset protocol fails closed for a missing/deleted image: <img> fires
  // onerror and this fallback is the only signal (mirrors imagePaste.ts's
  // deliberate fail-closed, no banner). The <img> stays in the DOM but hidden
  // so the message replaces it visually. Reset per path so switching from a
  // broken image to a valid one clears the fallback.
  let failed = $state(false)
  $effect(() => {
    void path
    failed = false
  })
</script>

<div class="image-view" data-testid="image-view">
  <img {src} class:hidden={failed} alt={path.split('/').pop()} onerror={() => (failed = true)} />
  {#if failed}
    <p class="failed">Could not load image.</p>
  {/if}
</div>

<style>
  .image-view {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 24px;
    overflow: auto;
    background: var(--bg);
  }
  .image-view img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .image-view img.hidden {
    display: none;
  }
  .failed {
    color: var(--fg-muted);
    font: 14px var(--font-ui);
  }
</style>
