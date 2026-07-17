<script lang="ts">
  import { errorMessage, clearError } from './lib/errors'
</script>

{#if $errorMessage}
  <div class="banner" role="alert">
    <span>{$errorMessage}</span>
    <button onclick={clearError} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: #fdecea;
    color: #611a15;
    font: 13px system-ui, sans-serif;
  }
  button { border: none; background: none; font-size: 16px; cursor: pointer; }
</style>
