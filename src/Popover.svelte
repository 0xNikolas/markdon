<script lang="ts">
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import type { Snippet } from 'svelte'

  /**
   * The shared top-anchored popover shell for GoToLineBar (bar variant) and
   * QuickOpen (palette variant): a portaled, pointer-events:none backdrop
   * (outside clicks fall through to the app) with a focus-trapped, centered
   * `role=dialog` panel. The caller owns all keyboard handling via `onKeydown`
   * (Enter/Arrows/Escape); `onDismiss` fires on an outside pointerdown only.
   */
  interface Props {
    ariaLabel: string
    variant: 'bar' | 'palette'
    onDismiss: () => void
    onKeydown: (e: KeyboardEvent) => void
    children: Snippet
  }
  let { ariaLabel, variant, onDismiss, onKeydown, children }: Props = $props()

  // Outside-click dismiss (mirrors FileOpsMenu's onWindowPointerDown pattern
  // rather than a clickable backdrop div: the backdrop is pointer-events:none,
  // so a click outside lands on the app; Escape is the caller's onKeydown).
  let panelEl = $state<HTMLElement>()
  function onWindowPointerDown(e: PointerEvent) {
    if (panelEl && !panelEl.contains(e.target as Node)) onDismiss()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="backdrop" use:portal>
  <div
    bind:this={panelEl}
    class="popover {variant}"
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
  /* Full-window fixed layer that eats no pointer events itself (outside clicks
     reach the app and dismiss via the window pointerdown handler); only the
     panel is interactive. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
  }
  /* Top-aligned like VS Code's quick pick, a shared 64px drop. */
  .popover {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: auto;
    display: flex;
    background: var(--modal-bg);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-popover);
    font: 13px var(--font-ui);
  }
  .popover.bar {
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
  }
  .popover.palette {
    flex-direction: column;
    gap: 6px;
    width: 520px;
    max-width: calc(100vw - 48px);
    box-sizing: border-box;
    padding: 8px;
    border-radius: 8px;
  }
</style>
