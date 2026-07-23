<script lang="ts">
  import { errorMessage, clearError, notice, clearNotice, revealLog } from './lib/errors'
</script>

{#if $errorMessage}
  <div class="banner" role="alert">
    <span>{$errorMessage}</span>
    <span class="actions">
      <!-- Error banners only (not notices): every reportError also lands in the
           log (errors.ts), so "Details…" reveals that log file for the fuller
           story behind the one-line message. -->
      <button class="details" onclick={revealLog} title="Reveal the app log in the file manager"
        >Details…</button
      >
      <button onclick={clearError} aria-label="Dismiss">×</button>
    </span>
  </div>
{/if}
{#if $notice}
  <div class="banner info" role="status">
    <span>{$notice}</span>
    <button onclick={clearNotice} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: var(--error-bg);
    color: var(--error-fg);
    font: 13px var(--font-ui);
  }
  /* Info variant: benign notices (e.g. open file detached after Trash). */
  .banner.info {
    background: var(--info-bg);
    color: var(--info-fg);
    border-bottom: 1px solid var(--info-border);
  }
  button {
    border: none;
    background: none;
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    color: inherit;
    transition: background-color 0.1s ease;
  }
  button:hover {
    background: var(--surface-hover);
  }
  button:active {
    background: var(--surface-active);
  }
  /* Quiet secondary action inside the banner: text-sized, underlined. */
  .details {
    font: 12px var(--font-ui);
    text-decoration: underline;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>
