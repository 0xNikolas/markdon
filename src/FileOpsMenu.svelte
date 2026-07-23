<script lang="ts" module>
  export type FileOpAction =
    | 'new-file'
    | 'new-folder'
    | 'open'
    | 'open-tab'
    | 'open-window'
    | 'open-instance'
    | 'reveal'
    | 'copy-path'
    | 'close'
    | 'rename'
    | 'duplicate'
    | 'move'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'delete'
    | 'select-all'
    | 'close-folder'
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import { selection, clipboard } from './lib/fileOpsState'
  import { folderPaths } from './lib/fileTree'
  import { workspace, isMarkdownFile, isImageFile } from './lib/workspace'
  import { clampMenuPosition, fileMenuVisibility } from './lib/sidebarMenu'

  interface Props {
    hasRows: boolean
    onAction: (action: FileOpAction) => void
    onClose: () => void
    /** Cursor position for context-menu use: fixed-position + viewport-clamped.
        Null → the original anchored-dropdown rendering, unchanged. */
    at?: { x: number; y: number } | null
    /** Paths currently in the Open Files strip (pinned + preview) — gates the
        Close item. Defaulted so the header "…" dropdown (which never renders
        the cursor-only file actions) can omit it. */
    openPaths?: ReadonlySet<string>
  }
  let { hasRows, onAction, onClose, at = null, openPaths = new Set() }: Props = $props()

  // Enablement derived honestly from selection + clipboard + workspace state.
  let count = $derived($selection.size)
  let hasRoot = $derived($workspace.root !== null)
  let canPaste = $derived($clipboard !== null)

  // The single selected path (or null) and its type/open-state, shared by the
  // open-target trio and the cursor-mode file actions below.
  let singlePath = $derived($selection.size === 1 ? [...$selection][0] : null)
  let singleName = $derived(singlePath?.split('/').filter(Boolean).pop() ?? '')
  let isFolderSel = $derived(singlePath !== null && folderPaths($workspace.tree).has(singlePath))
  let isFileSel = $derived(singlePath !== null && !isFolderSel)

  // The Open in New Tab/Window/Instance trio only ever acts on ONE openable
  // document: enablement mirrors Rename's single-selection honesty, plus "is
  // actually a markdown file" — folders and context-only files never open.
  let singleMarkdownFile = $derived(isFileSel && isMarkdownFile(singleName))

  // Which cursor-mode file actions to show for the single selected file
  // (Open / Reveal in Finder / Copy Path / Close). Gated by file type + open
  // membership in one place (sidebarMenu.fileMenuVisibility); the header "…"
  // dropdown renders none of these (they are `at !== null` only, below).
  let fileVis = $derived(
    fileMenuVisibility({
      isFile: isFileSel,
      isMarkdown: singleMarkdownFile,
      isImage: isFileSel && isImageFile(singleName),
      isOpen: singlePath !== null && openPaths.has(singlePath),
    }),
  )
  // Open leads the open-target cluster only when it renders — otherwise Open in
  // New Tab keeps its own divider (header dropdown + non-openable rows).
  let showOpen = $derived(at !== null && fileVis.open)

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
    // Cursor-mode file actions (row right-click only, never the header "…"
    // dropdown). "Open" leads the open-target cluster for an openable file
    // (markdown → current tab, image → image view); it starts the group so
    // Open in New Tab drops its own divider whenever Open is present.
    ...(showOpen ? [{ action: 'open' as const, label: 'Open', enabled: true, group: true }] : []),
    { action: 'open-tab', label: 'Open in New Tab', enabled: singleMarkdownFile, group: !showOpen },
    { action: 'open-window', label: 'Open in New Window', enabled: singleMarkdownFile },
    { action: 'open-instance', label: 'Open in New Instance', enabled: singleMarkdownFile },
    // Reveal / Copy Path work for ANY single file (open or merely listed);
    // Close appears only while the file is in the Open Files strip. All are
    // cursor-mode only and drop entirely for folders/multi/empty selections.
    ...(at !== null && fileVis.reveal
      ? [{ action: 'reveal' as const, label: 'Reveal in Finder', enabled: true, group: true }]
      : []),
    ...(at !== null && fileVis.copyPath
      ? [{ action: 'copy-path' as const, label: 'Copy Path', enabled: true }]
      : []),
    ...(at !== null && fileVis.close
      ? [{ action: 'close' as const, label: 'Close', enabled: true }]
      : []),
    { action: 'rename', label: 'Rename…', enabled: count === 1, group: true },
    { action: 'duplicate', label: 'Duplicate', enabled: count >= 1 },
    { action: 'move', label: 'Move to…', enabled: count >= 1 },
    { action: 'cut', label: 'Cut', enabled: count >= 1, group: true },
    { action: 'copy', label: 'Copy', enabled: count >= 1 },
    { action: 'paste', label: 'Paste', enabled: canPaste },
    { action: 'delete', label: 'Delete', enabled: count >= 1, danger: true, group: true },
    { action: 'select-all', label: 'Select All', enabled: hasRows, group: true },
    { action: 'close-folder', label: 'Close Folder', enabled: hasRoot, group: true },
  ])

  let menuEl: HTMLDivElement
  let buttons: HTMLButtonElement[] = $state([])

  // Cursor mode: measure the real rendered size, then clamp to the viewport.
  // Starts at the raw cursor point (pre-measure paint is one frame at most).
  let fixedPos = $state<{ x: number; y: number } | null>(null)
  $effect(() => {
    if (!at) {
      fixedPos = null
      return
    }
    const w = menuEl?.offsetWidth ?? 190
    const h = menuEl?.offsetHeight ?? 340
    fixedPos = clampMenuPosition(at.x, at.y, { w, h }, {
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
    const root = at ? menuEl : (menuEl?.parentElement ?? menuEl)
    if (root && !root.contains(e.target as Node)) onClose()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={menuEl}
  class="menu"
  class:cursor={at !== null}
  style={fixedPos ? `left: ${fixedPos.x}px; top: ${fixedPos.y}px;` : undefined}
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
