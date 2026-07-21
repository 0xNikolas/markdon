<script lang="ts">
  import Icon from './Icon.svelte'
  import {
    workspace,
    isMarkdownFile,
    fileIcon,
    folderIcon,
    openWorkspace,
    type WorkspaceDir,
    type WorkspaceFile,
  } from './lib/workspace'
  import { isInsideRoot } from './lib/ui'

  interface Props {
    activePath: string | null
    onOpenFile: (path: string) => void
    onNewFile: () => void
  }
  let { activePath, onOpenFile, onNewFile }: Props = $props()

  // Collapse state keyed by dir path. Absent/false = expanded (matches the
  // design's open folders); toggled per folder, local to this component.
  let collapsed = $state<Record<string, boolean>>({})

  // A file opened without (or outside) a workspace grant still has an open
  // doc but no tree row to show it in -- surface it as its own "Open File"
  // section (VS Code Open Editors-style) instead of leaving the sidebar
  // silent about what's on screen. Never expands the filesystem allowlist:
  // this only reads $workspace.root, already granted by openWorkspace().
  let showOpenFile = $derived(
    activePath !== null && ($workspace.root === null || !isInsideRoot(activePath, $workspace.root)),
  )
  let openFileName = $derived(activePath?.split('/').filter(Boolean).pop() ?? activePath ?? '')
</script>

{#snippet fileRow(f: WorkspaceFile)}
  {#if isMarkdownFile(f.name)}
    <button
      class="file-row"
      class:active={f.path === activePath}
      onclick={() => onOpenFile(f.path)}
    >
      <span class="active-bar"></span>
      <Icon name={fileIcon(f.name)} size={16} />
      <span class="name">{f.name}</span>
    </button>
  {:else}
    <!-- Non-markdown files are shown for context but can't be opened here. -->
    <div class="file-row disabled" aria-disabled="true">
      <span class="active-bar"></span>
      <Icon name={fileIcon(f.name)} size={16} />
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
    <Icon name={folderIcon(!collapsed[d.path])} size={16} />
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
  {#if showOpenFile}
    <div class="header">
      <span class="label">Open File</span>
    </div>
    <div class="tree">
      <div class="file-row active static" aria-current="true">
        <span class="active-bar"></span>
        <Icon name={fileIcon(openFileName)} size={16} />
        <span class="name">{openFileName}</span>
      </div>
    </div>
  {/if}
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
  {:else}
    <!-- No workspace open yet: an always-visible sidebar (rather than one that
         only appears once a folder is picked) teaches the feature on first
         run, matching the design's populated state -- this empty panel is
         its unpopulated counterpart, not a hidden mode. -->
    <div class="empty">
      <span class="empty-icon"><Icon name="folder-open" size={28} /></span>
      <p class="empty-title">No folder open</p>
      <p class="empty-body">Open a folder to browse its markdown files here.</p>
      <button class="open-folder" onclick={openWorkspace}>
        <Icon name="folder" size={14} />
        Open Folder
      </button>
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
    padding: 4px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fg-faint);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .new-file:hover {
    background: var(--surface-hover);
    color: var(--fg-secondary);
  }
  .new-file:active {
    background: var(--surface-active);
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
    border-radius: 6px;
    background: none;
    color: var(--fg-secondary);
    font: 500 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }
  .folder-row:hover {
    background: var(--surface-hover);
  }
  .folder-row:active {
    background: var(--surface-active);
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
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  /* .disabled rows are a plain <div> (non-markdown files, not openable here) --
     excluded from hover/active so they never look interactive. */
  .file-row:not(.active):not(.disabled):hover {
    background: var(--surface-hover);
    color: var(--fg-secondary);
  }
  .file-row:not(.active):not(.disabled):active {
    background: var(--surface-active);
  }
  .file-row.active {
    background: var(--accent-tint);
    color: var(--fg-strong);
    font-weight: 600;
  }
  .file-row.active:hover,
  .file-row.active:active {
    background: var(--accent-tint-strong);
  }
  .file-row.disabled {
    cursor: default;
  }
  /* The "Open File" row is not a button -- it's already the open doc, so
     clicking it is a no-op. Same active styling, but no pointer affordance. */
  .file-row.static {
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

  /* Ghost panel shown when no workspace is open -- discoverable entry point
     for openWorkspace() beyond the File menu. */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 4px;
    padding: 24px 12px;
    margin-top: 12px;
  }
  .empty-icon {
    display: inline-flex;
    color: var(--fg-faint);
    opacity: 0.6;
    margin-bottom: 8px;
  }
  .empty-title {
    margin: 0;
    font: 600 13px var(--font-ui);
    color: var(--fg-secondary);
  }
  .empty-body {
    margin: 0 0 12px;
    font: 400 12px var(--font-ui);
    color: var(--fg-faint);
  }
  .open-folder {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--accent-solid);
    color: var(--on-accent);
    font: 600 12px var(--font-ui);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }
  .open-folder:hover {
    background: var(--accent-solid-hover);
  }
  .open-folder:active {
    background: var(--accent-solid-active);
  }
</style>
