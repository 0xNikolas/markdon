<script lang="ts">
  import Modal from './Modal.svelte'
  import { autofocus } from './lib/autofocus'
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

  // A leaf name only — leafNameError mirrors the backend's valid_leaf_name
  // gate so the user gets immediate feedback rather than a round-trip error
  // banner. Shared with the sidebar's inline rename.
  let invalid = $derived(leafNameError(value) !== null)

  function submit(e: Event) {
    e.preventDefault()
    if (invalid) return
    onConfirm(value.trim())
  }
</script>

<Modal width="320px" onClose={onCancel}>
  <form onsubmit={submit}>
    <label class="title" for="name-modal-input">{title}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="name-modal-input"
      use:autofocus={{ selectTo }}
      bind:value
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-autofocus
    />
    <div class="modal-actions">
      <button type="button" class="btn-ghost" onclick={onCancel}>Cancel</button>
      <button type="submit" class="btn-ghost btn-primary" disabled={invalid}>{confirmLabel}</button>
    </div>
  </form>
</Modal>

<style>
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
</style>
