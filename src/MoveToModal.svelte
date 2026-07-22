<script lang="ts">
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import { workspace } from './lib/workspace'
  import { isSelfOrDescendant, folderRows } from './lib/fileops'

  interface Props {
    /** Paths being moved — used to disable invalid destinations. */
    sources: string[]
    onConfirm: (destDir: string) => void
    onCancel: () => void
  }
  let { sources, onConfirm, onCancel }: Props = $props()

  let rows = $derived(folderRows($workspace.tree))

  // A destination is invalid if it's a selected folder itself or a descendant of
  // one (move-into-itself), or the immediate parent of a lone source (no-op).
  function disabled(path: string): boolean {
    if (sources.some((s) => isSelfOrDescendant(path, s))) return true
    if (sources.length === 1) {
      const parent = sources[0].split('/').slice(0, -1).join('/')
      if (parent === path) return true
    }
    return false
  }

  const { onKeydown } = dialogDismissHandlers(() => onCancel())
</script>

<div class="modal-backdrop" use:portal>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" use:focusTrap onkeydown={onKeydown}>
    <p class="title">Move to…</p>
    <div class="list" role="listbox" aria-label="Destination folder">
      {#each rows as row (row.path)}
        <button
          class="row"
          role="option"
          aria-selected="false"
          disabled={disabled(row.path)}
          style="padding-left:{10 + row.depth * 14}px"
          onclick={() => onConfirm(row.path)}
        >
          {row.label}
        </button>
      {/each}
    </div>
    <div class="actions">
      <button type="button" data-autofocus onclick={onCancel}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .modal {
    background: var(--modal-bg);
    color: var(--fg);
    padding: 20px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font: 14px var(--font-ui);
    width: 340px;
    max-width: calc(100vw - 32px);
  }
  .title {
    margin: 0 0 12px;
    font: 600 13px var(--font-ui);
    color: var(--fg-strong);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
  }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fg-secondary);
    font: 400 13px var(--font-ui);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .row:not(:disabled):hover,
  .row:not(:disabled):focus-visible {
    background: var(--surface-hover);
    color: var(--fg-strong);
    outline: none;
  }
  .row:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .actions button {
    padding: 6px 14px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid transparent;
    color: var(--fg-secondary);
    font: inherit;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }
  .actions button:hover {
    background: var(--surface-hover);
  }
</style>
