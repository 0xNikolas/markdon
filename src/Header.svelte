<script lang="ts">
  import Icon from './Icon.svelte'
  import { workspaceName, split, toggleSplit, requestExport, openSettings } from './lib/ui'

  interface Props {
    path: string | null
    dirty: boolean
  }
  let { path, dirty }: Props = $props()

  const filename = $derived(path ? path.split('/').pop() : 'Untitled')
</script>

<!-- data-tauri-drag-region="deep": the whole bar drags the window and
     double-click maximizes; buttons are clickable elements, which Tauri's
     injected drag script exempts from dragging automatically. -->
<header class="header" data-tauri-drag-region="deep">
  <div class="left">
    <!-- Native traffic lights overlay here (x=20 + 52px wide group). -->
    <span class="traffic-spacer" aria-hidden="true"></span>
    <span class="brand">
      <span class="chip">m&gt;<span class="caret"></span></span>
      <span class="wordmark">markdon</span>
    </span>
  </div>
  <div class="center">
    {#if $workspaceName}<span class="crumb">{$workspaceName} /</span>{/if}
    <span class="filename">{filename}</span>
    {#if dirty}
      <span class="badge edited">Edited</span>
    {:else if path}
      <span class="badge saved">Saved</span>
    {/if}
  </div>
  <div class="right">
    <button class="btn primary" aria-pressed={$split} onclick={toggleSplit}>
      <Icon name="split-square-vertical" />
      Split Preview
    </button>
    <button class="btn" onclick={requestExport}>
      <Icon name="file-up" />
      Export
    </button>
    <button class="btn icon-only" aria-label="Settings" onclick={openSettings}>
      <Icon name="settings" />
    </button>
  </div>
</header>

<style>
  .header {
    display: grid;
    grid-template-columns: 1fr auto 1fr; /* true centering regardless of side widths */
    align-items: center;
    padding: 14px 20px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .left {
    display: flex;
    align-items: center;
    gap: 24px;
    min-width: 0;
  }
  .traffic-spacer {
    width: 52px; /* + 20px header padding = 72px inset for the native lights */
    flex-shrink: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #0f1729; /* fixed in BOTH themes (nodes 11:135 / 11:17) */
    color: #ffffff;
    border-radius: 4px;
    padding: 4px 8px;
    font: 700 13px var(--font-mono);
    line-height: 1;
  }
  .caret {
    width: 4px;
    height: 14px;
    background: var(--accent);
    border-radius: 1px;
  }
  .wordmark {
    font: 700 15px var(--font-ui);
    color: var(--fg-strong);
  }
  .center {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .crumb {
    font: 400 13px var(--font-mono);
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .filename {
    font: 600 13px var(--font-ui);
    color: var(--fg-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    padding: 2px 6px;
    border-radius: 4px;
    font: 600 10px var(--font-ui);
    line-height: 1.4;
    white-space: nowrap;
  }
  .badge.edited {
    background: var(--accent-tint);
    color: var(--accent);
  }
  .badge.saved {
    background: var(--surface);
    color: var(--fg-secondary);
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid transparent;
    font: 500 12px var(--font-ui);
    color: var(--fg-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
  }
  .btn:hover {
    background: var(--surface-hover);
  }
  .btn:active {
    background: var(--surface-active);
  }
  .btn.primary {
    color: var(--fg-strong);
    border-color: var(--surface-border);
  }
  /* Split Preview, pressed (aria-pressed="true"): accent border + accent-tint
     bg + accent icon/text, in both themes. Hover/active deepen the tint so the
     pressed control still shows a clear affordance on top of pressed state.
     Text/icon color uses --accent-tint-fg (not bare --accent): in light theme
     --accent composited on the tint is only ~2.9:1, below the WCAG 3:1 floor
     for UI text/icons -- --accent-tint-fg is a darker shade that clears 4.5:1. */
  .btn.primary[aria-pressed='true'] {
    background: var(--accent-tint);
    border-color: var(--accent);
    color: var(--accent-tint-fg);
  }
  .btn.primary[aria-pressed='true']:hover,
  .btn.primary[aria-pressed='true']:active {
    background: var(--accent-tint-strong);
  }
  .btn.icon-only {
    width: 30px;
    height: 30px;
    padding: 8px;
    justify-content: center;
  }
</style>
