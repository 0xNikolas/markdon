<script lang="ts" module>
  /** One row of a {@link ContextMenu}. `A` is the caller's action union so
      onSelect stays typed end-to-end. */
  export interface MenuItem<A extends string = string> {
    action: A
    label: string
    enabled: boolean
    /** Start a new visual group (divider rendered above, unless index 0). */
    group?: boolean
    /** Danger styling (e.g. Delete). */
    danger?: boolean
  }
</script>

<script lang="ts" generics="A extends string">
  import { tick } from 'svelte'
  import { clampMenuPosition } from './lib/sidebarMenu'

  interface Props {
    items: MenuItem<A>[]
    /** Cursor point → fixed-position + viewport-clamped. Null → the anchored
        dropdown rendering (absolute, top:calc(100%+4px), right:0) inside a
        position:relative parent, unchanged. */
    at?: { x: number; y: number } | null
    /** role=menu aria-label ("File operations" | "Open file actions"). */
    ariaLabel: string
    onClose: () => void
    onSelect: (action: A) => void
  }
  let { items, at = null, ariaLabel, onClose, onSelect }: Props = $props()

  let menuEl: HTMLDivElement
  let buttons: HTMLButtonElement[] = $state([])

  // Cursor mode: measure the real rendered size, then clamp to the viewport.
  // Starts at the raw cursor point (pre-measure paint is one frame at most).
  let pos = $state<{ x: number; y: number } | null>(null)
  $effect(() => {
    if (!at) {
      pos = null
      return
    }
    const w = menuEl?.offsetWidth ?? 176
    const h = menuEl?.offsetHeight ?? 200
    pos = clampMenuPosition(at.x, at.y, { w, h }, {
      w: window.innerWidth,
      h: window.innerHeight,
    })
  })

  function enabledIndices(): number[] {
    return items.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0)
  }

  // Roving focus: move between ENABLED items only; disabled items are skipped.
  function focusAt(idx: number) {
    buttons[idx]?.focus()
  }

  async function focusFirst() {
    await tick()
    const first = enabledIndices()[0]
    if (first !== undefined) focusAt(first)
  }
  // Focus the first enabled item when the menu mounts (keyboard entry point),
  // AND re-focus whenever the menu is re-targeted to a new cursor position.
  // Right-clicking row A then row B without an intervening close keeps this same
  // instance mounted — `at` just swaps to a new object — so without a reactive
  // dependency the mount-only effect never re-runs. If the new selection
  // disables the currently-focused item (e.g. Rename when count > 1), the
  // browser auto-blurs it to <body>, and the menu's onkeydown (bound to a
  // descendant) then never sees Escape. Reading `at` here re-establishes roving
  // focus on every re-target and keeps the menu keyboard-operable.
  $effect(() => {
    void at
    focusFirst()
  })

  function currentIndex(): number {
    return buttons.findIndex((b) => b === document.activeElement)
  }

  function onKeydown(e: KeyboardEvent) {
    const enabled = enabledIndices()
    if (enabled.length === 0) return
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onClose()
        break
      case 'ArrowDown': {
        e.preventDefault()
        const p = enabled.indexOf(currentIndex())
        focusAt(enabled[(p + 1) % enabled.length] ?? enabled[0])
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const p = enabled.indexOf(currentIndex())
        focusAt(p <= 0 ? enabled[enabled.length - 1] : enabled[p - 1])
        break
      }
      case 'Home':
        e.preventDefault()
        focusAt(enabled[0])
        break
      case 'End':
        e.preventDefault()
        focusAt(enabled[enabled.length - 1])
        break
    }
  }

  function activate(it: MenuItem<A>) {
    if (!it.enabled) return
    onClose()
    onSelect(it.action)
  }

  // Close on any pointer press outside the menu's anchor. In anchored mode the
  // parent wraps both the trigger button and this menu, so pressing the button
  // counts as "inside" — its own onclick then handles the toggle-closed without
  // a double-fire. (Svelte emits no DOM wrapper, so `.menu` stays a direct
  // child of the caller's position:relative anchor.)
  function onWindowPointerDown(e: PointerEvent) {
    const root = at ? menuEl : (menuEl?.parentElement ?? menuEl)
    if (root && !root.contains(e.target as Node)) onClose()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={menuEl}
  class="menu"
  class:cursor={at !== null}
  style={pos
    ? `left: ${pos.x}px; top: ${pos.y}px;`
    : at
      ? `left: ${at.x}px; top: ${at.y}px;`
      : undefined}
  role="menu"
  tabindex="-1"
  aria-label={ariaLabel}
  onkeydown={onKeydown}
>
  {#each items as it, i (it.action)}
    {#if it.group && i !== 0}
      <div class="divider" role="separator"></div>
    {/if}
    <button
      bind:this={buttons[i]}
      class="item"
      class:danger={it.danger}
      role="menuitem"
      tabindex={it.enabled ? 0 : -1}
      disabled={!it.enabled}
      aria-disabled={!it.enabled}
      onclick={() => activate(it)}
    >
      {it.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 176px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--modal-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-popover);
  }
  .menu.cursor {
    position: fixed;
    top: auto;
    right: auto;
    z-index: 30; /* above sidebar chrome; below modals (z 100) */
  }
  .item {
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
  .item:not(:disabled):hover,
  .item:not(:disabled):focus-visible {
    background: var(--surface-hover);
    color: var(--fg-strong);
    outline: none;
  }
  .item:not(:disabled):active {
    background: var(--surface-active);
  }
  .item:disabled {
    color: var(--fg-faint);
    opacity: 0.5;
    cursor: default;
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger:not(:disabled):hover,
  .item.danger:not(:disabled):focus-visible {
    background: var(--danger-tint);
    color: var(--danger);
  }
  .divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>
