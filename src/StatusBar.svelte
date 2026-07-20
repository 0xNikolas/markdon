<script lang="ts">
  import { themePref, toggleTheme } from './lib/theme'

  interface Props {
    path: string | null
    dirty: boolean
    content: string
  }
  let { path, dirty, content }: Props = $props()

  const filename = $derived(path ? path.split('/').pop() : 'Untitled')
  // Count runs of letters/digits (keeping apostrophes/hyphens inside words) so
  // markdown syntax tokens like `#`, `*`, `>` aren't counted as words.
  const words = $derived(
    (content.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length,
  )

  // NOTE: a later settings feature moves this control into a settings modal;
  // kept small and self-contained here so it's easy to relocate.
  const themeLabel = $derived(
    $themePref === 'system' ? 'Auto' : $themePref === 'light' ? 'Light' : 'Dark',
  )
</script>

<footer class="status">
  <span class="name">{filename}{dirty ? ' •' : ''}</span>
  <div class="right">
    <span class="words">{words} words</span>
    <button class="theme-toggle" onclick={toggleTheme} aria-label="Switch theme">
      {themeLabel}
    </button>
  </div>
</footer>

<style>
  .status {
    display: flex;
    justify-content: space-between;
    padding: 4px 12px;
    font: 12px system-ui, sans-serif;
    border-top: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
  }
  .right { display: flex; align-items: center; gap: 8px; }
  .theme-toggle {
    font: inherit;
    color: inherit;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
  }
</style>
