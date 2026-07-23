<script lang="ts">
  import Icon from './Icon.svelte'
  import FileOpsMenu, { type FileOpAction } from './FileOpsMenu.svelte'

  interface Props {
    /** Controlled by Sidebar: the header dropdown and the row context menu
        are mutually exclusive, so opening one must close the other. */
    menuOpen: boolean
    hasRows: boolean
    onNewFile: () => void
    onToggleMenu: () => void
    onCloseMenu: () => void
    onAction: (action: FileOpAction) => void
  }
  let { menuOpen, hasRows, onNewFile, onToggleMenu, onCloseMenu, onAction }: Props = $props()
</script>

<div class="header">
  <span class="label">Workspace</span>
  <div class="header-actions">
    <button class="new-file" aria-label="New file" onclick={onNewFile}>
      <Icon name="file-plus" size={14} />
    </button>
    <div class="fileops-anchor">
      <button
        class="new-file"
        aria-label="File operations"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={onToggleMenu}
      >
        <Icon name="ellipsis" size={14} />
      </button>
      {#if menuOpen}
        <FileOpsMenu {hasRows} {onAction} onClose={onCloseMenu} />
      {/if}
    </div>
  </div>
</div>

<style>
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
  .header-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  /* Positioning context for the FileOpsMenu dropdown anchored under the button. */
  .fileops-anchor {
    position: relative;
    display: inline-flex;
  }
</style>
