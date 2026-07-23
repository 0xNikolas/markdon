<script lang="ts">
  import Icon from './Icon.svelte'
  import { get } from 'svelte/store'
  import {
    workspace,
    isMarkdownFile,
    fileIcon,
    folderIcon,
    type WorkspaceDir,
    type WorkspaceFile,
  } from './lib/workspace'
  import { selection, clipboard, focused, focusRow } from './lib/fileOpsState'
  import { performRename } from './lib/fileMutations'
  import { leafNameError, visibleRowPaths, folderPaths } from './lib/fileTree'
  import { treeKeyIntent } from './lib/treeNav'
  import {
    collapsed,
    toggleFolder,
    setFolderCollapsed,
    renaming,
    renameValue,
    renameCommit,
    stemLength,
  } from './lib/treeState'

  interface Props {
    activePath: string | null
    /** Same contract as Sidebar's prop: `preview` = single-click glance,
        `inPlace` = dblclick/explicit open that bypasses openMode routing. */
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    /** Row right-click — the sidebar owns the cursor-anchored FileOpsMenu. */
    onRowContextMenu: (e: MouseEvent, path: string) => void
  }
  let { activePath, onOpenFile, onRowContextMenu }: Props = $props()

  // Cut items dim until pasted or the clipboard is cleared.
  let cutSet = $derived(
    $clipboard?.mode === 'cut' ? new Set($clipboard.paths) : new Set<string>(),
  )

  let treeEl = $state<HTMLDivElement>()

  // Roving tabindex (ARIA tree pattern): exactly one row is tabbable — the
  // focused row when it's visible, else the first row — so Tab enters the
  // tree once and arrow keys move within it.
  let visibleRows = $derived(visibleRowPaths($workspace.tree, $collapsed))
  let tabAnchor = $derived(
    $focused !== null && visibleRows.includes($focused) ? $focused : (visibleRows[0] ?? null),
  )

  // Move the selection/focus anchor AND real DOM focus to a row. DOM focus is
  // explicit because WebKit does not focus <button>s on click, and the next
  // keydown needs a focus origin inside the tree for navigation to work.
  function focusRowDom(path: string) {
    focusRow(path)
    treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
  }

  // Keyboard navigation: the pure decision lives in treeNav.ts; this handler
  // only applies the returned intent. Enter/Space need no code here — rows
  // are <button>s, so native activation fires the existing click handlers.
  function onTreeKeydown(e: KeyboardEvent) {
    // The rename input owns its keys (arrows move the caret; Enter/Escape are
    // handled on the input itself) — never treat them as tree navigation.
    if ((e.target as HTMLElement | null)?.closest?.('.rename-input')) return
    const intent = treeKeyIntent(
      e.key,
      $focused,
      visibleRows,
      folderPaths($workspace.tree),
      $collapsed,
    )
    if (intent === null) return
    e.preventDefault() // handled — keep arrows/Home/End from scrolling the panel
    if (intent.kind === 'expand') setFolderCollapsed(intent.path, false)
    else if (intent.kind === 'collapse') setFolderCollapsed(intent.path, true)
    else focusRowDom(intent.path)
  }

  // Focus the fresh rename input and preselect the stem (files) or the whole
  // name (folders) — Svelte action, runs once per input mount.
  function renameSetup(node: HTMLInputElement, selectTo: number | null) {
    node.focus()
    if (selectTo !== null) node.setSelectionRange(0, selectTo)
    else node.select()
  }

  // Commit = performRename, which already retargets the doc/openList/preview
  // and refreshes + reselects. renameCommit (treeState.ts) holds the decision:
  // an unchanged or invalid name commits as a cancel, and the `skip` outcome
  // makes this idempotent — Enter/Escape resolve the rename first, and the
  // input's teardown blur then no-ops instead of double-committing.
  function commitRename(path: string) {
    const outcome = renameCommit(get(renaming), path, get(renameValue))
    if (outcome.kind === 'skip') return
    renaming.set(null)
    if (outcome.kind === 'commit') performRename(path, outcome.newName)
  }

  function onRenameKeydown(e: KeyboardEvent, path: string) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(path)
    } else if (e.key === 'Escape') {
      e.stopPropagation() // keep the window-level Escape handler (find bar) out of it
      renaming.set(null)
    }
  }

  // Row click: single-select + focus (the paste/new anchor). A markdown
  // file's single click additionally PREVIEWS it (VS Code semantics: italic
  // strip row, always in-place); the second click of a dblclick no-ops in
  // App (already active), then onFileDblClick pins it.
  function onFileClick(f: WorkspaceFile) {
    focusRowDom(f.path)
    if (isMarkdownFile(f.name)) onOpenFile(f.path, { preview: true })
  }
  function onFileDblClick(f: WorkspaceFile) {
    // A tree dblclick means "open in THIS window" by definition — `inPlace`
    // bypasses openMode routing, so a dblclick racing its own first click's
    // still-loading preview can never spawn a duplicate window under
    // openMode:'window'.
    if (isMarkdownFile(f.name)) onOpenFile(f.path, { preview: false, inPlace: true })
  }
  function onFolderClick(d: WorkspaceDir) {
    focusRowDom(d.path)
    toggleFolder(d.path)
  }
</script>

{#snippet fileRow(f: WorkspaceFile)}
  {#if $renaming === f.path}
    <!-- Inline rename swaps the row's <button> for a div: an input inside a
         button is invalid HTML. The .rename-input class is load-bearing —
         isSelectionClearingTarget matches it so caret clicks don't deselect.
         Deliberate ARIA-pattern deviation: the renaming row is role-less —
         it's a transient edit state whose input carries its own aria-label. -->
    <div class="file-row renaming">
      <span class="active-bar"></span>
      <Icon name={fileIcon(f.name)} size={16} />
      <input
        class="rename-input"
        class:invalid={leafNameError($renameValue) !== null}
        bind:value={$renameValue}
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="Rename {f.name}"
        use:renameSetup={stemLength(f.name)}
        onkeydown={(e) => onRenameKeydown(e, f.path)}
        onblur={() => commitRename(f.path)}
      />
    </div>
  {:else}
    <button
      class="file-row"
      class:active={f.path === activePath}
      class:selected={$selection.has(f.path) && f.path !== activePath}
      class:cut={cutSet.has(f.path)}
      role="treeitem"
      aria-selected={$selection.has(f.path) || f.path === activePath}
      aria-current={f.path === activePath ? 'true' : undefined}
      data-path={f.path}
      tabindex={tabAnchor === f.path ? 0 : -1}
      onclick={() => onFileClick(f)}
      ondblclick={() => onFileDblClick(f)}
      oncontextmenu={(e) => onRowContextMenu(e, f.path)}
    >
      <span class="active-bar"></span>
      <Icon name={fileIcon(f.name)} size={16} />
      <span class="name">{f.name}</span>
    </button>
  {/if}
{/snippet}

{#snippet dirRows(d: WorkspaceDir)}
  {#if $renaming === d.path}
    <!-- Same div-for-button swap as the file row; folders preselect the whole
         name (no extension stem to protect). -->
    <div class="folder-row renaming">
      <span class="chevron" class:open={!$collapsed[d.path]}>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={folderIcon(!$collapsed[d.path])} size={16} />
      <input
        class="rename-input"
        class:invalid={leafNameError($renameValue) !== null}
        bind:value={$renameValue}
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="Rename {d.name}"
        use:renameSetup={null}
        onkeydown={(e) => onRenameKeydown(e, d.path)}
        onblur={() => commitRename(d.path)}
      />
    </div>
  {:else}
    <button
      class="folder-row"
      class:selected={$selection.has(d.path)}
      class:cut={cutSet.has(d.path)}
      role="treeitem"
      aria-selected={$selection.has(d.path)}
      aria-expanded={!$collapsed[d.path]}
      data-path={d.path}
      tabindex={tabAnchor === d.path ? 0 : -1}
      onclick={() => onFolderClick(d)}
      oncontextmenu={(e) => onRowContextMenu(e, d.path)}
    >
      <span class="chevron" class:open={!$collapsed[d.path]}>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={folderIcon(!$collapsed[d.path])} size={16} />
      <span class="name">{d.name}</span>
    </button>
  {/if}
  {#if !$collapsed[d.path]}
    <!-- role=group ties the children to the folder treeitem above it. Nesting
         depth is conveyed by the group structure alone (aria-level/posinset/
         setsize are an optional follow-up — VoiceOver derives them). -->
    <div class="indent" role="group">
      {#each d.dirs as sub (sub.path)}{@render dirRows(sub)}{/each}
      {#each d.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {/if}
{/snippet}

{#if $workspace.tree}
  <!-- data-testid: the strip and the workspace tree are visually identical
       .tree containers whose rows can render the same file names — e2e
       locators need an unambiguous scope for each.
       aria-label: the parent nav is "Workspace"; the tree widget needs its
       own name. tabindex=-1 keeps the container out of the tab order (the
       roving row tabindex is the single entry point) while satisfying the
       focusable-widget contract for the keydown handler. -->
  <div
    class="tree"
    data-testid="workspace-tree"
    role="tree"
    aria-label="Workspace files"
    tabindex="-1"
    bind:this={treeEl}
    onkeydown={onTreeKeydown}
  >
    {#each $workspace.tree.dirs as d (d.path)}{@render dirRows(d)}{/each}
    {#each $workspace.tree.files as f (f.path)}{@render fileRow(f)}{/each}
  </div>
{/if}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .indent {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 12px;
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--fg-secondary);
    font: 500 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }
  .folder-row:hover {
    background: var(--surface-hover);
  }
  .folder-row:active {
    background: var(--surface-active);
  }
  .chevron {
    display: inline-flex;
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }
  .chevron.open {
    transform: rotate(90deg);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px 8px 16px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--fg-muted);
    font: 400 13px var(--font-ui);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  /* Non-markdown rows (.nonmd) are now selectable buttons (focus/cut/copy/
     move/delete) but never open a document; they read as slightly muted via
     their file-text icon. Hover/active applies to every non-open row. */
  .file-row:not(.active):hover {
    background: var(--surface-hover);
    color: var(--fg-secondary);
  }
  .file-row:not(.active):active {
    background: var(--surface-active);
  }
  .file-row.active {
    background: var(--accent-tint);
    color: var(--fg-strong);
    font-weight: 600;
  }
  .file-row.active:hover,
  .file-row.active:active {
    background: var(--accent-tint-strong);
  }
  /* Selected-but-not-open rows (multi-select via Select All, or a focused
     folder/non-md file): a quiet surface fill distinct from the accent-tinted
     open row. */
  .file-row.selected:not(.active),
  .folder-row.selected {
    background: var(--surface-hover);
    color: var(--fg-strong);
  }
  /* Cut items dim until pasted or the clipboard is cleared. */
  .file-row.cut,
  .folder-row.cut {
    opacity: 0.5;
  }
  .active-bar {
    width: 3px;
    height: 14px;
    border-radius: 1.5px;
    background: transparent;
    flex-shrink: 0;
  }
  .file-row.active .active-bar {
    background: var(--accent);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Inline rename: the row swaps its <button> for a div+input pair, so kill
     the row-button affordances (pointer cursor, hover fill) for its duration.
     Placed after the hover rules above so the equal-specificity override wins. */
  .file-row.renaming,
  .folder-row.renaming {
    cursor: default;
  }
  .file-row.renaming:hover,
  .folder-row.renaming:hover {
    background: none;
  }
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    font: 400 13px var(--font-ui);
  }
  .rename-input:focus-visible {
    outline: none;
  }
  /* Live leafNameError feedback; a commit with this border showing cancels. */
  .rename-input.invalid {
    border-color: var(--danger);
  }
</style>
