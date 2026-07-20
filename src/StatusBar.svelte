<script lang="ts">
  import { watchStatus, cursor, formatInt, lnColText, watchLabel } from './lib/ui'

  interface Props {
    content: string
  }
  let { content }: Props = $props()

  // Count runs of letters/digits (keeping apostrophes/hyphens inside words) so
  // markdown syntax tokens like `#`, `*`, `>` aren't counted as words.
  const words = $derived(
    (content.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length,
  )
</script>

<footer class="status">
  <div class="left">
    <span class="watch">
      <span class="dot" class:live={$watchStatus === 'watching'}></span>
      <span class="watch-label">{watchLabel($watchStatus)}</span>
    </span>
    <span class="meta">UTF-8</span>
  </div>
  <div class="right">
    {#if $cursor}
      <span class="meta">{lnColText($cursor)}</span>
    {/if}
    <span class="meta">{formatInt(words)} words</span>
    <span class="meta">{formatInt(content.length)} chars</span>
  </div>
</footer>

<style>
  .status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 20px;
    background: var(--bg);
    border-top: 1px solid var(--border);
  }
  .left {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .watch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-muted);
  }
  .dot.live {
    background: var(--status-live);
  }
  .watch-label {
    font: 400 12px var(--font-ui);
    color: var(--fg-secondary);
  }
  .meta {
    font: 400 12px var(--font-mono);
    color: var(--fg-muted);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
</style>
