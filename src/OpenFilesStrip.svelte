<script lang="ts" module>
  /** Strip-row context-menu actions, routed to App's handleStripAction. */
  export type StripRowAction =
    | 'close'
    | 'close-others'
    | 'close-saved'
    | 'close-all'
    | 'copy-path'
    | 'reveal'
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { fileIcon } from './lib/workspace'
  import { basename } from './lib/treeState'
  import { stripOrder } from './lib/openList'
  import { stripKeyIntent } from './lib/stripNav'
  import { clampMenuPosition } from './lib/sidebarMenu'

  interface Props {
    openFiles: string[]
    /** The single-click preview slot (openList.ts) — the strip's italic row. */
    previewPath: string | null
    activePath: string | null
    /** Rows whose stashed background buffers hold unsaved edits (a dirty dot
        makes the invisible cache state visible; the active row's dirtiness is
        already the Header's Edited badge). Previews are never cached. */
    dirtyPaths?: ReadonlySet<string>
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    onCloseFile: (path: string) => void
    /** Row context-menu action (Close variants / Copy Path / Reveal); the
        semantics live in App.svelte so 'close' shares onCloseFile's guards. */
    onStripAction: (action: StripRowAction, path: string) => void
  }
  let {
    openFiles,
    previewPath,
    activePath,
    dirtyPaths = new Set(),
    onOpenFile,
    onCloseFile,
    onStripAction,
  }: Props = $props()

  // The italic preview row, rendered only while the previewed path isn't
  // pinned — pinning moves it into openFiles and the slot clears, so a
  // lingering equal value must not draw a duplicate row.
  let previewRow = $derived(
    previewPath !== null && !openFiles.includes(previewPath) ? previewPath : null,
  )

  // -- keyboard navigation (roving tabindex over the row buttons) -------------
  // The rows stay <button>s (NOT role=listbox/option): the e2e locator
  // contract targets getByRole('button', { name }) throughout, each row is
  // structurally TWO sibling buttons (open + close), and a flat list of
  // buttons with one tab stop is valid a11y — so only the tabindex is roved
  // (stripNav.ts holds the pure ArrowUp/Down/Home/End decisions; Enter/Space
  // are native button activation).
  let rows = $derived(stripOrder(openFiles, previewRow))
  let stripEl = $state<HTMLDivElement>()
  // The roving anchor: the last row focus visited, else the active row, else
  // the first — exactly one main button is tabbable at a time.
  let focusedIdx = $state<number | null>(null)
  let tabAnchor = $derived.by(() => {
    if (focusedIdx !== null && focusedIdx < rows.length) return focusedIdx
    const active = activePath === null ? -1 : rows.indexOf(activePath)
    return active === -1 ? 0 : active
  })

  function focusRowIndex(i: number) {
    focusedIdx = i
    stripEl?.querySelector<HTMLElement>(`[data-strip-index="${i}"]`)?.focus()
  }

  function onRowKeydown(e: KeyboardEvent, index: number) {
    const intent = stripKeyIntent(e.key, index, rows.length)
    if (intent === null) return
    e.preventDefault() // handled — keep arrows/Home/End from scrolling the panel
    focusRowIndex(intent.index)
  }

  // -- row context menu -------------------------------------------------------
  // Same machinery as the workspace tree's FileOpsMenu in cursor mode
  // (fixed-position, viewport-clamped via clampMenuPosition, dismissed by any
  // outside pointer press or Escape) — rebuilt inline rather than reusing
  // FileOpsMenu because the item set is disjoint (close variants vs fileops).
  let ctxMenu = $state<{ x: number; y: number; path: string } | null>(null)
  let menuEl = $state<HTMLDivElement>()
  let itemEls: HTMLButtonElement[] = $state([])

  interface MenuItem {
    action: StripRowAction
    label: string
    enabled: boolean
    /** Start a new visual group (divider rendered above). */
    group?: boolean
  }
  let menuItems = $derived<MenuItem[]>([
    { action: 'close', label: 'Close', enabled: true },
    // With a single row there is nothing "other" to close.
    { action: 'close-others', label: 'Close Others', enabled: rows.length > 1 },
    { action: 'close-saved', label: 'Close Saved', enabled: true },
    { action: 'close-all', label: 'Close All', enabled: true },
    { action: 'copy-path', label: 'Copy Path', enabled: true, group: true },
    { action: 'reveal', label: 'Reveal in Finder', enabled: true },
  ])

  function onRowContextMenu(e: MouseEvent, path: string) {
    // preventDefault mirrors the window-level WKWebView-menu suppression;
    // stopPropagation keeps the Sidebar's panel-level contextmenu handler
    // (empty-space deselect) out of it.
    e.preventDefault()
    e.stopPropagation()
    ctxMenu = { x: e.clientX, y: e.clientY, path }
  }

  // Measure the rendered menu, then clamp to the viewport (FileOpsMenu's
  // cursor-mode pattern; the pre-measure paint is one frame at most).
  let menuPos = $state<{ x: number; y: number } | null>(null)
  $effect(() => {
    if (!ctxMenu) {
      menuPos = null
      return
    }
    const w = menuEl?.offsetWidth ?? 176
    const h = menuEl?.offsetHeight ?? 200
    menuPos = clampMenuPosition(ctxMenu.x, ctxMenu.y, { w, h }, {
      w: window.innerWidth,
      h: window.innerHeight,
    })
  })

  // Focus the first enabled item on open AND on re-target to another row
  // (right-click row A then row B keeps this instance mounted — reading
  // `ctxMenu` re-runs the effect), keeping the menu keyboard-operable.
  $effect(() => {
    void ctxMenu
    void focusFirstItem()
  })
  async function focusFirstItem() {
    await tick()
    const first = menuItems.findIndex((it) => it.enabled)
    if (first !== -1) itemEls[first]?.focus()
  }

  function enabledIndices(): number[] {
    return menuItems.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0)
  }

  function onMenuKeydown(e: KeyboardEvent) {
    const enabled = enabledIndices()
    if (enabled.length === 0) return
    const pos = enabled.indexOf(itemEls.findIndex((b) => b === document.activeElement))
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        ctxMenu = null
        break
      case 'ArrowDown':
        e.preventDefault()
        itemEls[enabled[(pos + 1) % enabled.length]]?.focus()
        break
      case 'ArrowUp':
        e.preventDefault()
        itemEls[enabled[pos <= 0 ? enabled.length - 1 : pos - 1]]?.focus()
        break
      case 'Home':
        e.preventDefault()
        itemEls[enabled[0]]?.focus()
        break
      case 'End':
        e.preventDefault()
        itemEls[enabled[enabled.length - 1]]?.focus()
        break
    }
  }

  function activateMenuItem(it: MenuItem) {
    if (!it.enabled || !ctxMenu) return
    const path = ctxMenu.path
    ctxMenu = null
    onStripAction(it.action, path)
  }

  // Close on any pointer press outside the menu (the opening right-click's
  // own pointerdown precedes the menu mount, so it never self-dismisses).
  function onWindowPointerDown(e: PointerEvent) {
    if (ctxMenu && menuEl && !menuEl.contains(e.target as Node)) ctxMenu = null
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#if openFiles.length > 0 || previewRow !== null}
  <!-- VS Code "Open Editors"-style strip: every opened document, in- or
       out-of-workspace, so there's one consistent surface for "what's on
       screen" rather than the tree alone. Paths-only --
       the single-doc model is unchanged, this is just a switch list. -->
  <div class="header">
    <span class="label">Open Files</span>
  </div>
  <!-- data-testid: the strip and the workspace tree are visually identical
       .tree containers whose rows can render the same file names — e2e
       locators need an unambiguous scope for each. -->
  <div class="tree" data-testid="open-files" bind:this={stripEl}>
    {#each openFiles as path, i (path)}
      <!-- Two sibling buttons, not a nested button-in-button: the row opens
           the file, the small trailing button closes it (stopPropagation
           so a close click never also switches to it first). The row-level
           contextmenu listener is a right-click-only menu trigger covering
           both buttons and the gap between them — not an activation, so the
           div stays role-less (same pattern as the sidebar <nav>'s panel
           handler). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="open-file-row"
        class:active={path === activePath}
        oncontextmenu={(e) => onRowContextMenu(e, path)}
      >
        <button
          class="open-file-main"
          aria-current={path === activePath ? 'true' : undefined}
          data-strip-index={i}
          tabindex={tabAnchor === i ? 0 : -1}
          onclick={() => onOpenFile(path)}
          onkeydown={(e) => onRowKeydown(e, i)}
          onfocus={() => (focusedIdx = i)}
        >
          <span class="active-bar"></span>
          <Icon name={fileIcon(basename(path))} size={16} />
          <span class="name">{basename(path)}</span>
          {#if dirtyPaths.has(path)}
            <span class="dirty-dot" role="img" aria-label="Unsaved changes"></span>
          {/if}
        </button>
        <button
          class="close-file"
          aria-label="Close {basename(path)}"
          onclick={(e) => { e.stopPropagation(); onCloseFile(path) }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/each}
    {#if previewRow !== null}
      {@const pv = previewRow}
      {@const pvIdx = openFiles.length}
      <!-- The single-click preview: ONE italic row after the pinned ones.
           Clicking it re-asserts the preview (a no-op while it's already
           the active doc) rather than pinning — only a tree dblclick, an
           explicit open, or editing the buffer promotes it. The italics are
           invisible to a screen reader, so both aria-labels carry the
           "(preview)" state in words. Enter on the already-active row PINS
           it — the keyboard's promotion affordance, mirroring the mouse's
           dblclick (preventDefault keeps the button's synthetic click, which
           would merely re-preview, from also firing); other keys fall
           through to the shared arrow-navigation handler. The row div's
           contextmenu listener is a menu trigger, not an activation (see the
           pinned row above). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="open-file-row preview"
        class:active={pv === activePath}
        oncontextmenu={(e) => onRowContextMenu(e, pv)}
      >
        <button
          class="open-file-main"
          aria-label="{basename(pv)} (preview)"
          aria-current={pv === activePath ? 'true' : undefined}
          data-strip-index={pvIdx}
          tabindex={tabAnchor === pvIdx ? 0 : -1}
          onclick={() => onOpenFile(pv, { preview: true })}
          onfocus={() => (focusedIdx = pvIdx)}
          onkeydown={(e) => {
            if (e.key === 'Enter' && pv === activePath) {
              e.preventDefault()
              onOpenFile(pv, { preview: false, inPlace: true })
              return
            }
            onRowKeydown(e, pvIdx)
          }}
        >
          <span class="active-bar"></span>
          <Icon name={fileIcon(basename(pv))} size={16} />
          <span class="name">{basename(pv)}</span>
        </button>
        <button
          class="close-file"
          aria-label="Close {basename(pv)} (preview)"
          onclick={(e) => { e.stopPropagation(); onCloseFile(pv) }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}
  </div>
{/if}

{#if ctxMenu}
  <div
    bind:this={menuEl}
    class="menu"
    style={menuPos ? `left: ${menuPos.x}px; top: ${menuPos.y}px;` : `left: ${ctxMenu.x}px; top: ${ctxMenu.y}px;`}
    role="menu"
    tabindex="-1"
    aria-label="Open file actions"
    onkeydown={onMenuKeydown}
  >
    {#each menuItems as it, i (it.action)}
      {#if it.group && i !== 0}
        <div class="divider" role="separator"></div>
      {/if}
      <button
        bind:this={itemEls[i]}
        class="item"
        role="menuitem"
        tabindex={it.enabled ? 0 : -1}
        disabled={!it.enabled}
        aria-disabled={!it.enabled}
        onclick={() => activateMenuItem(it)}
      >
        {it.label}
      </button>
    {/each}
  </div>
{/if}

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

  .tree {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .active-bar {
    width: 3px;
    height: 14px;
    border-radius: 1.5px;
    background: transparent;
    flex-shrink: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Open Files row: two sibling buttons (open-file-main + close-file) inside
     a plain div, not a nested button-in-button. Matches .file-row's look but
     the row itself carries no click handler -- only its children do (the
     row-level contextmenu listener is a menu trigger, not an activation). */
  .open-file-row {
    display: flex;
    align-items: center;
    width: 100%;
    border-radius: 6px;
    transition: background-color 0.1s ease;
  }
  .open-file-row:hover {
    background: var(--surface-hover);
  }
  .open-file-row.active {
    background: var(--accent-tint);
  }
  .open-file-row.active:hover {
    background: var(--accent-tint-strong);
  }
  .open-file-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 8px 4px 8px 16px;
    border: 0;
    background: none;
    color: var(--fg-muted);
    font: 400 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
  }
  .open-file-row.active .open-file-main {
    color: var(--fg-strong);
    font-weight: 600;
  }
  .open-file-row.active .open-file-main .active-bar {
    background: var(--accent);
  }
  /* Hidden until the row is hovered/focused, but always in the tab order
     (keyboard-reachable per the close-affordance requirement). */
  .close-file {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin-right: 8px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fg-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
  }
  .open-file-row:hover .close-file,
  .open-file-row:focus-within .close-file,
  .close-file:focus-visible {
    opacity: 1;
  }
  .close-file:hover {
    background: var(--surface-active);
    color: var(--fg-secondary);
  }
  /* The preview row's name renders italic — VS Code's "this tab is a glance,
     not a commitment" signal. Everything else matches a pinned row. */
  .open-file-row.preview .name {
    font-style: italic;
  }
  /* Dirty dot: a stashed background buffer with unsaved edits (VS Code's
     modified-tab marker) — without it a stashed edit would be invisible
     until the user returned to the tab. */
  .dirty-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  /* Row context menu: FileOpsMenu's cursor-mode look, verbatim, so the two
     read as one system (fixed, viewport-clamped, above sidebar chrome). */
  .menu {
    position: fixed;
    z-index: 30; /* above sidebar chrome; below modals (z 100) */
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
  .divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>
