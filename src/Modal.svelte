<script lang="ts">
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import type { Snippet } from 'svelte'

  /**
   * The shared centered-dialog shell: a portaled backdrop with a focus-trapped
   * `role=dialog` box and Escape-to-close, byte-copied across the discard
   * guard (App), the delete-confirm (Sidebar), NameModal and MoveToModal. The
   * caller authors the body as a child snippet and owns every guard — `onClose`
   * fires on Escape only (e.g. App gates it behind `if (!saving)`); it is NOT a
   * backdrop click (this shell has no click-to-dismiss, matching the copies).
   */
  interface Props {
    onClose: () => void
    /** '320px' | '340px'; omit for content-sized (max-width 320px). */
    width?: string
    ariaLabel?: string
    /** App discard only — retargets a deferred preview-open on backdrop dblclick. */
    onBackdropDblClick?: (e: MouseEvent) => void
    children: Snippet
  }
  let { onClose, width, ariaLabel, onBackdropDblClick, children }: Props = $props()

  const { onKeydown } = dialogDismissHandlers(() => onClose())
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" use:portal ondblclick={onBackdropDblClick}>
  <div
    class="modal"
    class:sized={width}
    style={width ? `width:${width}` : undefined}
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel}
    tabindex="-1"
    use:focusTrap
    onkeydown={onKeydown}
  >
    {@render children()}
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
    max-width: 320px;
  }
  .modal.sized {
    max-width: calc(100vw - 32px);
  }
</style>
