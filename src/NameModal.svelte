<script lang="ts">
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import { leafNameError } from './lib/fileTree'

  interface Props {
    title: string
    initial?: string
    confirmLabel?: string
    /** Chars to preselect on open (e.g. a filename stem, excluding the extension). */
    selectTo?: number | null
    onConfirm: (value: string) => void
    onCancel: () => void
  }
  let {
    title,
    initial = '',
    confirmLabel = 'Create',
    selectTo = null,
    onConfirm,
    onCancel,
  }: Props = $props()

  // The modal is remounted per open (keyed by its parent {#if}), so capturing
  // `initial` once is exactly right.
  // svelte-ignore state_referenced_locally
  let value = $state(initial)
  let inputEl = $state<HTMLInputElement>()

  // A leaf name only — leafNameError mirrors the backend's valid_leaf_name
  // gate so the user gets immediate feedback rather than a round-trip error
  // banner. Shared with the sidebar's inline rename.
  let invalid = $derived(leafNameError(value) !== null)

  $effect(() => {
    // Preselect the stem so typing replaces the name but keeps the extension.
    if (inputEl) {
      if (selectTo !== null) inputEl.setSelectionRange(0, selectTo)
      else inputEl.select()
    }
  })

  function submit(e: Event) {
    e.preventDefault()
    if (invalid) return
    onConfirm(value.trim())
  }

  const { onKeydown } = dialogDismissHandlers(() => onCancel())
</script>

<div class="modal-backdrop" use:portal>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1" use:focusTrap onkeydown={onKeydown}>
    <form onsubmit={submit}>
      <label class="title" for="name-modal-input">{title}</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="name-modal-input"
        bind:this={inputEl}
        bind:value
        type="text"
        autocomplete="off"
        spellcheck="false"
        data-autofocus
      />
      <div class="actions">
        <button type="button" onclick={onCancel}>Cancel</button>
        <button type="submit" class="primary" disabled={invalid}>{confirmLabel}</button>
      </div>
    </form>
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
    width: 320px;
    max-width: calc(100vw - 32px);
  }
  .title {
    display: block;
    font: 600 13px var(--font-ui);
    color: var(--fg-strong);
    margin-bottom: 8px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font: 13px var(--font-ui);
  }
  input:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
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
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .actions button:not(:disabled):hover {
    background: var(--surface-hover);
  }
  .actions button:not(:disabled):active {
    background: var(--surface-active);
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: var(--accent-solid);
    border-color: transparent;
    color: var(--on-accent);
    font-weight: 600;
  }
  .primary:not(:disabled):hover {
    background: var(--accent-solid-hover);
  }
  .primary:not(:disabled):active {
    background: var(--accent-solid-active);
  }
</style>
