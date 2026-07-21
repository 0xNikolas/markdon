<script lang="ts" module>
  export type FileOpAction =
    | 'new-file'
    | 'new-folder'
    | 'rename'
    | 'duplicate'
    | 'move'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'delete'
    | 'select-all'
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import { selection, clipboard } from './lib/fileops'
  import { workspace } from './lib/workspace'

  interface Props {
    hasRows: boolean
    onAction: (action: FileOpAction) => void
    onClose: () => void
  }
  let { hasRows, onAction, onClose }: Props = $props()

  // Enablement derived honestly from selection + clipboard + workspace state.
  let count = $derived($selection.size)
  let hasRoot = $derived($workspace.root !== null)
  let canPaste = $derived($clipboard !== null)

  interface Item {
    action: FileOpAction
    label: string
    enabled: boolean
    danger?: boolean
    /** Start a new visual group (divider rendered above). */
    group?: boolean
  }

  let items = $derived<Item[]>([
    { action: 'new-file', label: 'New File', enabled: hasRoot },
    { action: 'new-folder', label: 'New Folder', enabled: hasRoot },
    { action: 'rename', label: 'Rename…', enabled: count === 1, group: true },
    { action: 'duplicate', label: 'Duplicate', enabled: count >= 1 },
    { action: 'move', label: 'Move to…', enabled: count >= 1 },
    { action: 'cut', label: 'Cut', enabled: count >= 1, group: true },
    { action: 'copy', label: 'Copy', enabled: count >= 1 },
    { action: 'paste', label: 'Paste', enabled: canPaste },
    { action: 'delete', label: 'Delete', enabled: count >= 1, danger: true, group: true },
    { action: 'select-all', label: 'Select All', enabled: hasRows, group: true },
  ])

  let menuEl: HTMLDivElement
  let buttons: HTMLButtonElement[] = $state([])

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
  // Focus the first enabled item when the menu mounts (keyboard entry point).
  $effect(() => {
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
        const pos = enabled.indexOf(currentIndex())
        focusAt(enabled[(pos + 1) % enabled.length] ?? enabled[0])
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const pos = enabled.indexOf(currentIndex())
        focusAt(pos <= 0 ? enabled[enabled.length - 1] : enabled[pos - 1])
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

  function activate(it: Item) {
    if (!it.enabled) return
    onClose()
    onAction(it.action)
  }

  // Close on any pointer press outside the menu's anchor. The anchor wraps both
  // the trigger button and this menu, so pressing the button counts as "inside"
  // — its own onclick then handles the toggle-closed without a double-fire.
  function onWindowPointerDown(e: PointerEvent) {
    const anchor = menuEl?.parentElement ?? menuEl
    if (anchor && !anchor.contains(e.target as Node)) onClose()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={menuEl}
  class="menu"
  role="menu"
  tabindex="-1"
  aria-label="File operations"
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
