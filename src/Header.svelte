<script lang="ts">
  import Icon from './Icon.svelte'
  import { workspaceName, fileBreadcrumb, split, toggleSplit, requestExport } from './lib/ui'
  import { openOverlay } from './lib/overlay'
  import { workspace } from './lib/workspace'
  import { resolvedTheme } from './lib/theme'
  import { updateSetting } from './lib/settings'
  import wordmarkLight from './assets/brand/wordmark-light.svg?raw'
  import wordmarkDark from './assets/brand/wordmark-dark.svg?raw'

  interface Props {
    path: string | null
    dirty: boolean
    /** Empty-state page shown: no document, so no breadcrumb/filename. */
    empty?: boolean
    /** Image view shown: `path` is the image, so show its filename breadcrumb
        but never a Saved/Edited badge (an image is not an editable document). */
    image?: boolean
  }
  let { path, dirty, empty = false, image = false }: Props = $props()

  const breadcrumb = $derived(
    empty ? { crumbs: [], filename: '' } : fileBreadcrumb(path, $workspace.root, $workspaceName),
  )
</script>

<!-- data-tauri-drag-region="deep": the whole bar drags the window and
     double-click maximizes; buttons are clickable elements, which Tauri's
     injected drag script exempts from dragging automatically. -->
<header class="header" data-tauri-drag-region="deep">
  <div class="left">
    <!-- Native traffic lights overlay here (x=20 + 52px wide group). -->
    <span class="traffic-spacer" aria-hidden="true"></span>
    <!-- Two 120x28 wordmark variants ship in the DOM; [data-theme] on :root
         toggles which is visible (CSS-only, no JS theme subscription). -->
    <span class="brand" role="img" aria-label="Markdon">
      <span class="wordmark-light" aria-hidden="true">{@html wordmarkLight}</span>
      <span class="wordmark-dark" aria-hidden="true">{@html wordmarkDark}</span>
    </span>
  </div>
  <div class="center">
    {#if breadcrumb.crumbs.length}
      <span class="crumb">{breadcrumb.crumbs.join(' / ')} /</span>
    {/if}
    <span class="filename">{breadcrumb.filename}</span>
    {#if dirty && !image}
      <span class="badge edited">Edited</span>
    {:else if path && !image}
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
    <!-- Two-state flip on the RESOLVED theme: clicking always sets an explicit
         light/dark pref (persisted via settings, the themePref single writer);
         'system' remains available in Settings. -->
    <button
      class="btn icon-only"
      aria-label={$resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      onclick={() => updateSetting('theme', $resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Icon name={$resolvedTheme === 'dark' ? 'sun' : 'moon'} />
    </button>
    <!-- openOverlay refuses (silent no-op) if any overlay is already up — that
         refusal IS the fix for the gear stacking a second focus trap. -->
    <button class="btn icon-only" aria-label="Settings" onclick={() => openOverlay({ kind: 'settings' })}>
      <Icon name="settings" />
    </button>
  </div>
</header>

<style>
  .header {
    display: grid;
    /* minmax(0, auto): true centering, but the middle column can still shrink
       below its content size instead of pushing the side buttons off-screen. */
    grid-template-columns: 1fr minmax(0, auto) 1fr;
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
  }
  .brand :global(svg) {
    display: block;
    width: 120px;
    height: 28px;
  }
  /* Light-theme wordmark shows by default; dark-theme variant swaps in via
     :root[data-theme='dark'] (see app.css). Both stay in the DOM so the swap
     is pure CSS -- no JS theme subscription needed here. */
  .wordmark-dark {
    display: none;
  }
  :global(:root[data-theme='dark']) .wordmark-light {
    display: none;
  }
  :global(:root[data-theme='dark']) .wordmark-dark {
    display: block;
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
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    max-width: 240px; /* deeply nested workspace paths truncate instead of pushing the buttons */
    flex-shrink: 1;
  }
  .filename {
    font: 600 13px var(--font-ui);
    color: var(--fg-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex-shrink: 1;
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
