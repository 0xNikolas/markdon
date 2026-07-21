<script lang="ts">
  import Icon from './Icon.svelte'
  import { workspace, isMarkdownFile, type WorkspaceDir, type WorkspaceFile } from './lib/workspace'

  interface Props {
    activePath: string | null
    onOpenFile: (path: string) => void
    onNewFile: () => void
  }
  let { activePath, onOpenFile, onNewFile }: Props = $props()

  // Collapse state keyed by dir path. Absent/false = expanded (matches the
  // design's open folders); toggled per folder, local to this component.
  let collapsed = $state<Record<string, boolean>>({})
</script>

{#snippet fileRow(f: WorkspaceFile)}
  {#if isMarkdownFile(f.name)}
    <button
      class="file-row"
      class:active={f.path === activePath}
      onclick={() => onOpenFile(f.path)}
    >
      <span class="active-bar"></span>
      <Icon name="file-code" size={16} />
      <span class="name">{f.name}</span>
    </button>
  {:else}
    <!-- Non-markdown files are shown for context but can't be opened here. -->
    <div class="file-row disabled" aria-disabled="true">
      <span class="active-bar"></span>
      <Icon name="file-code" size={16} />
      <span class="name">{f.name}</span>
    </div>
  {/if}
{/snippet}

{#snippet dirRows(d: WorkspaceDir)}
  <button
    class="folder-row"
    aria-expanded={!collapsed[d.path]}
    onclick={() => (collapsed[d.path] = !collapsed[d.path])}
  >
    <span class="chevron" class:open={!collapsed[d.path]}>
      <Icon name="chevron-right" size={12} />
    </span>
    <Icon name="folder" size={16} />
    <span class="name">{d.name}</span>
  </button>
  {#if !collapsed[d.path]}
    <div class="indent">
      {#each d.dirs as sub (sub.path)}{@render dirRows(sub)}{/each}
      {#each d.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {/if}
{/snippet}

<nav class="sidebar" aria-label="Workspace">
  <div class="header">
    <span class="label">Workspace</span>
    <button class="new-file" aria-label="New file" onclick={onNewFile}>
      <Icon name="file-plus" size={14} />
    </button>
  </div>
  {#if $workspace.tree}
    <div class="tree">
      {#each $workspace.tree.dirs as d (d.path)}{@render dirRows(d)}{/each}
      {#each $workspace.tree.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {/if}
</nav>

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 12px;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
  }
  .label {
    font: 700 11px var(--font-ui);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-faint);
  }
  .new-file {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-faint);
    cursor: pointer;
  }
  .new-file:hover {
    color: var(--fg-secondary);
  }

  .tree {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .indent {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 12px;
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 8px;
    border: 0;
    background: none;
    color: var(--fg-secondary);
    font: 500 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
  }
  .chevron {
    display: inline-flex;
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }
  .chevron.open {
    transform: rotate(90deg);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px 8px 16px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--fg-muted);
    font: 400 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
  }
  .file-row.active {
    background: var(--accent-tint);
    color: var(--fg-strong);
    font-weight: 600;
  }
  .file-row.disabled {
    cursor: default;
  }
  .active-bar {
    width: 3px;
    height: 14px;
    border-radius: 1.5px;
    background: transparent;
    flex-shrink: 0;
  }
  .file-row.active .active-bar {
    background: var(--accent);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
