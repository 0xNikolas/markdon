<script lang="ts">
  import { onDestroy } from 'svelte'
  import { watchStatus, cursor, formatInt, lnColText, watchLabel } from './lib/ui'
  import { createWordCounter } from './lib/textMetrics'

  interface Props {
    content: string
  }
  let { content }: Props = $props()

  // Size-adaptive word count: synchronous for small docs, deferred to idle
  // time above the sync limit -- so the count may be briefly stale on huge
  // docs (and 0 for the first effect tick). The chars count stays exact.
  let words = $state(0)
  const counter = createWordCounter((n) => (words = n))
  $effect(() => {
    counter.update(content)
  })
  onDestroy(() => counter.dispose())
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
