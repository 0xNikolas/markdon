<script lang="ts">
  import { onMount } from 'svelte'
  import { homeDir } from '@tauri-apps/api/path'
  import { isMacPlatform } from './lib/ui'
  import {
    workspace,
    listRecentWorkspaces,
    recentWorkspaceDisplay,
  } from './lib/workspace'
  import wordmarkLight from './assets/brand/wordmark-light.svg?raw'
  import wordmarkDark from './assets/brand/wordmark-dark.svg?raw'

  /**
   * The no-document empty page, rendered by App.svelte in place of the
   * editor while $emptyState is true (unclaimed boot with nothing to open,
   * or the last open file closed). Every action routes through the SAME
   * closures the native menu items use — no duplicated flow logic here.
   */
  interface Props {
    onNewFile: () => void
    onOpenFile: () => void
    onOpenFolder: () => void
    onOpenSettings: () => void
    onOpenRecent: (root: string) => void
  }
  let { onNewFile, onOpenFile, onOpenFolder, onOpenSettings, onOpenRecent }: Props = $props()

  // Real accelerators from src-tauri/src/menu.rs (CmdOrCtrl+…), rendered as
  // per-platform keycaps: mac symbols, Ctrl words elsewhere.
  const mac = isMacPlatform()
  const actions: { label: string; keys: string[]; run: () => void }[] = [
    { label: 'New file', keys: mac ? ['⌘', 'N'] : ['Ctrl', 'N'], run: () => onNewFile() },
    { label: 'Open file…', keys: mac ? ['⌘', 'O'] : ['Ctrl', 'O'], run: () => onOpenFile() },
    {
      label: 'Open folder…',
      keys: mac ? ['⇧', '⌘', 'O'] : ['Ctrl', 'Shift', 'O'],
      run: () => onOpenFolder(),
    },
    { label: 'Settings', keys: mac ? ['⌘', ','] : ['Ctrl', ','], run: () => onOpenSettings() },
  ]

  // Recent workspace roots (newest-first from the Rust MRU) and the home dir
  // used to abbreviate their parent paths. Both are best-effort: a failure
  // just hides the section / skips the ~ abbreviation.
  let roots = $state<string[]>([])
  let home = $state<string | null>(null)
  onMount(() => {
    void listRecentWorkspaces().then((r) => (roots = r))
    void homeDir()
      .then((h) => (home = h || null))
      .catch(() => {})
  })

  // Up to 5 rows, excluding the CURRENTLY open workspace (states (a)/(b) can
  // have one): "recent" means somewhere else to go, not where you already are.
  // $workspace-reactive so adopting a folder from a row re-filters instantly.
  const recents = $derived(
    roots
      .filter((r) => r !== $workspace.root)
      .slice(0, 5)
      .map((r) => ({ root: r, ...recentWorkspaceDisplay(r, home) })),
  )
</script>

<div class="empty-page" data-testid="empty-state">
  <div class="panel">
    <!-- Signature: the brand mark ghosted to a watermark (no standalone glyph
         ships in assets/brand, so the wordmark is the mark). Same CSS-only
         light/dark swap as Header.svelte. -->
    <span class="watermark" role="img" aria-label="Markdon">
      <span class="wordmark-light" aria-hidden="true">{@html wordmarkLight}</span>
      <span class="wordmark-dark" aria-hidden="true">{@html wordmarkDark}</span>
    </span>

    <div class="actions">
      {#each actions as action (action.label)}
        <button class="action" onclick={action.run}>
          <span class="label">{action.label}</span>
          <span class="keys" aria-hidden="true">
            {#each action.keys as key, i (i)}<kbd>{key}</kbd>{/each}
          </span>
        </button>
      {/each}
    </div>

    {#if recents.length > 0}
      <div class="recents" aria-labelledby="empty-recents-label">
        <span class="eyebrow" id="empty-recents-label">Recent</span>
        {#each recents as r (r.root)}
          <button class="recent" title={r.root} onclick={() => onOpenRecent(r.root)}>
            <span class="name">{r.name}</span>
            {#if r.parent}
              <span class="parent">{r.parent}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Fills the editor slot (sidebar/header/status bar stay). overflow:auto so
     a short window scrolls this pane, never the app shell; no entrance
     animation at all, so prefers-reduced-motion needs no carve-out. */
  .empty-page {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 32px 24px;
    background: var(--bg);
  }
  .panel {
    width: 100%;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  .watermark {
    display: flex;
    justify-content: center;
    opacity: 0.35;
  }
  .watermark :global(svg) {
    display: block;
    width: 180px;
    height: 42px;
    max-width: 100%;
  }
  .wordmark-dark {
    display: none;
  }
  :global(:root[data-theme='dark']) .wordmark-light {
    display: none;
  }
  :global(:root[data-theme='dark']) .wordmark-dark {
    display: block;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .action {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font: 13px var(--font-ui);
    color: var(--fg-secondary);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }
  .action:hover {
    background: var(--surface-hover);
  }
  .action:active {
    background: var(--surface-active);
  }
  .action .label {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .keys {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  kbd {
    display: inline-block;
    min-width: 18px;
    box-sizing: border-box;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font: 500 11px var(--font-ui);
    line-height: 16px;
    color: var(--fg-muted);
    text-align: center;
    background: transparent;
  }

  .recents {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .eyebrow {
    padding: 0 10px 4px;
    font: 600 11px var(--font-ui);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-faint);
  }
  .recent {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font: 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }
  .recent:hover {
    background: var(--surface-hover);
  }
  .recent:active {
    background: var(--surface-active);
  }
  .recent .name {
    font-weight: 600;
    color: var(--fg-secondary);
    flex-shrink: 0;
  }
  .recent .parent {
    font-size: 12px;
    color: var(--fg-muted);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
