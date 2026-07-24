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
  import Icon from './Icon.svelte'
  import { fileIcon, workspace } from './lib/workspace'
  import { basename } from './lib/treeState'
  import { stripOrder, openList, previewPath } from './lib/openList'
  import { dirtyCached } from './lib/bufferCache'
  import { stripKeyIntent } from './lib/stripNav'
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'

  interface Props {
    activePath: string | null
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    onCloseFile: (path: string) => void
    /** Row context-menu action (Close variants / Copy Path / Reveal); the
        semantics live in App.svelte so 'close' shares onCloseFile's guards. */
    onStripAction: (action: StripRowAction, path: string) => void
  }
  let {
    activePath,
    onOpenFile,
    onCloseFile,
    onStripAction,
  }: Props = $props()

  // The open-file list, single-click preview slot, and cached-dirty set are
  // read straight from their module-singleton stores (openList/previewPath in
  // ./lib/openList, dirtyCached in ./lib/bufferCache) — the same stores App
  // and QuickOpen subscribe to — rather than threaded down as props.

  // The italic preview row, rendered only while the previewed path isn't
  // pinned — pinning moves it into openList and the slot clears, so a
  // lingering equal value must not draw a duplicate row.
  let previewRow = $derived(
    $previewPath !== null && !$openList.includes($previewPath) ? $previewPath : null,
  )

  // -- keyboard navigation (roving tabindex over the row buttons) -------------
  // The rows stay <button>s (NOT role=listbox/option): the e2e locator
  // contract targets getByRole('button', { name }) throughout, each row is
  // structurally TWO sibling buttons (open + close), and a flat list of
  // buttons with one tab stop is valid a11y — so only the tabindex is roved
  // (stripNav.ts holds the pure ArrowUp/Down/Home/End decisions; Enter/Space
  // are native button activation).
  let rows = $derived(stripOrder($openList, previewRow))
  // The preview row renders FIRST (top slot) when present, so DOM
  // data-strip-index matches `rows` (stripOrder = preview-first): preview is
  // index 0 and pinned row i is index i + pinOffset. Keeping the two index
  // spaces aligned is what makes rows.indexOf(activePath) a valid tab anchor.
  let pinOffset = $derived(previewRow !== null ? 1 : 0)
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
  // The menu MECHANISM (positioning, roving focus, outside-press/Escape
  // dismiss) is shared with the workspace tree's FileOpsMenu via ContextMenu;
  // only the item set differs (close variants vs fileops), built here.
  let ctxMenu = $state<{ x: number; y: number; path: string } | null>(null)
  // The right-clicked row's path, snapshotted OUTSIDE reactivity: ContextMenu
  // fires onClose() (nulling ctxMenu) before onSelect(), so onSelect must NOT
  // read ctxMenu.path (a reactive read would recompute against the now-null
  // ctxMenu and throw). Set once when the menu opens; constant for its life.
  let menuPath = ''

  let menuItems = $derived<MenuItem<StripRowAction>[]>([
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
    menuPath = path
    ctxMenu = { x: e.clientX, y: e.clientY, path }
  }
</script>

{#if $workspace.tree !== null || rows.length > 0}
  <!-- VS Code "Open Editors"-style strip: every opened document, in- or
       out-of-workspace, so there's one consistent surface for "what's on
       screen" rather than the tree alone. Paths-only --
       the single-doc model is unchanged, this is just a switch list.

       ALWAYS rendered while a workspace is open, even with zero rows (the
       list reserves a fixed min-height, quiet blank when empty): mounting
       the section on the first preview/pin used to push the workspace tree
       down BETWEEN the two physical clicks of a dblclick, so the second
       click landed on a different row. Rows-only rendering remains for the
       no-workspace case (an OS-opened file with no tree below to shift). -->
  <div class="header">
    <span class="label">Open Files</span>
  </div>
  <!-- data-testid: the strip and the workspace tree are visually identical
       .tree containers whose rows can render the same file names — e2e
       locators need an unambiguous scope for each. -->
  <div class="tree" data-testid="open-files" bind:this={stripEl}>
    {#if previewRow !== null}
      {@const pv = previewRow}
      {@const pvIdx = 0}
      <!-- The single-click preview renders FIRST (top slot) — it is the most
           recently opened row under the newest-first order, and data-strip-index
           0 keeps it aligned with stripOrder (preview-first) so the roving tab
           anchor lands on the right row. Clicking it re-asserts the preview (a
           no-op while it's already the active doc) rather than pinning — only a
           tree dblclick, an explicit open, or editing the buffer promotes it.
           The italics are invisible to a screen reader, so both aria-labels
           carry the "(preview)" state in words. Enter on the already-active row
           PINS it — the keyboard's promotion affordance, mirroring the mouse's
           dblclick (preventDefault keeps the button's synthetic click, which
           would merely re-preview, from also firing); other keys fall through to
           the shared arrow-navigation handler. The row div's contextmenu
           listener is a menu trigger, not an activation (see the pinned rows
           below). -->
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
    {#each $openList as path, i (path)}
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
          data-strip-index={i + pinOffset}
          tabindex={tabAnchor === i + pinOffset ? 0 : -1}
          onclick={() => onOpenFile(path)}
          onkeydown={(e) => onRowKeydown(e, i + pinOffset)}
          onfocus={() => (focusedIdx = i + pinOffset)}
        >
          <span class="active-bar"></span>
          <Icon name={fileIcon(basename(path))} size={16} />
          <span class="name">{basename(path)}</span>
          {#if $dirtyCached.has(path)}
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
  </div>
{/if}

{#if ctxMenu}
  <!-- onSelect reads the non-reactive `menuPath` snapshot (see its declaration):
       ContextMenu nulls ctxMenu via onClose() before onSelect() runs. -->
  <ContextMenu
    items={menuItems}
    at={ctxMenu}
    ariaLabel="Open file actions"
    onClose={() => (ctxMenu = null)}
    onSelect={(a) => onStripAction(a, menuPath)}
  />
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

  /* Fixed-band list: min 3 rows, max 6, scroll beyond. One row is 32px
     (.open-file-main: 8px top + 8px bottom padding around 16px content —
     the icon; the 13px UI text line-box is shorter) plus the column's 4px
     gap between rows, so N rows measure N*32 + (N-1)*4:
       3 rows -> 104px (min)   6 rows -> 212px (max).
     The 3-row floor covers the common few-files case with ZERO layout
     shift below (the dblclick-race fix: empty->1, 1->2 and 2->3 all land
     inside the reserved band); a full 6-row reservation would fix 3->6
     too but permanently waste ~108px of sidebar with 0-1 files open —
     accepted tradeoff: the pane still grows at the rarer 3->4->5->6
     transitions, and never past 6 (overflow scrolls). */
  .tree {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 104px;
    max-height: 212px;
    /* The sidebar is itself a scrollable flex column; without this, an
       overfull sidebar would flex-squeeze the band back down to min-height
       (the explicit min-height overrides the auto content floor that
       protected it before) and reintroduce height instability. */
    flex-shrink: 0;
    overflow-y: auto;
    /* No custom scrollbar CSS exists anywhere (the sidebar/tree scroll on
       the platform's default overlay scrollbar); `thin` is the one standard
       knob that keeps this inner scrollbar quieter than the sidebar's own. */
    scrollbar-width: thin;
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
</style>
