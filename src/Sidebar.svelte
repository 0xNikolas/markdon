<script lang="ts">
  import Icon from './Icon.svelte'
  import FileOpsMenu, { type FileOpAction } from './FileOpsMenu.svelte'
  import NameModal from './NameModal.svelte'
  import MoveToModal from './MoveToModal.svelte'
  import { invoke } from '@tauri-apps/api/core'
  import {
    workspace,
    isMarkdownFile,
    fileIcon,
    folderIcon,
    openWorkspace,
    closeWorkspace,
    type WorkspaceDir,
    type WorkspaceFile,
  } from './lib/workspace'
  import { openInNewWindow } from './lib/files'
  import { reportError } from './lib/errors'
  import {
    selection,
    focused,
    clipboard,
    focusRow,
    cutSelection,
    copySelection,
    selectVisible,
    clearSelection,
  } from './lib/fileOpsState'
  import {
    paste,
    performCreateFile,
    performCreateFolder,
    performRename,
    performDuplicate,
    performMove,
    performDelete,
  } from './lib/fileMutations'
  import { pasteTargetDir, folderPaths, leafNameError } from './lib/fileTree'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import { ancestorDirs } from './lib/paths'
  import { get } from 'svelte/store'
  import { selectionForContextMenu, isSelectionClearingTarget } from './lib/sidebarMenu'

  interface Props {
    activePath: string | null
    openFiles: string[]
    /** The single-click preview slot (openList.ts) — the strip's italic row. */
    previewPath: string | null
    /** `preview` = single-click glance (always in-place); `inPlace` = the
        explicit Open in New Tab action, which bypasses openMode routing. */
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    onCloseFile: (path: string) => void
    onNewFile: () => void
  }
  let { activePath, openFiles, previewPath, onOpenFile, onCloseFile, onNewFile }: Props =
    $props()

  // Collapse state keyed by dir path. Absent/false = expanded (matches the
  // design's open folders); toggled per folder, local to this component.
  let collapsed = $state<Record<string, boolean>>({})

  // File-operations menu + modal state (local to the sidebar chrome).
  let menuOpen = $state(false)
  // Cursor-anchored File Operations menu (row right-click). Mutually exclusive
  // with the header "…" dropdown: opening one closes the other.
  let ctxMenu = $state<{ x: number; y: number } | null>(null)
  let nameModal = $state<{
    title: string
    initial: string
    confirmLabel: string
    selectTo: number | null
    onConfirm: (value: string) => void
  } | null>(null)
  let moveSources = $state<string[] | null>(null)
  let deleteConfirm = $state<{ paths: string[]; label: string } | null>(null)

  // Inline rename (VS Code style — no modal): the row whose name is being
  // edited plus the live input value. One rename at a time; NameModal stays
  // for New File / New Folder only.
  let renaming = $state<string | null>(null)
  let renameValue = $state('')

  // The italic preview row, rendered only while the previewed path isn't
  // pinned — pinning moves it into openFiles and the slot clears, so a
  // lingering equal value must not draw a duplicate row.
  let previewRow = $derived(
    previewPath !== null && !openFiles.includes(previewPath) ? previewPath : null,
  )

  // Cut items dim until pasted or the clipboard is cleared.
  let cutSet = $derived(
    $clipboard?.mode === 'cut' ? new Set($clipboard.paths) : new Set<string>(),
  )

  // Directory a New/Paste lands in: focused folder, focused file's parent, else root.
  function targetDir(): string | null {
    return pasteTargetDir($focused, folderPaths($workspace.tree), $workspace.root)
  }

  function isFolder(path: string): boolean {
    return folderPaths($workspace.tree).has(path)
  }

  // The offset of the extension dot, so a rename preselects just the stem.
  function stemLength(name: string): number {
    const dot = name.lastIndexOf('.')
    return dot > 0 ? dot : name.length
  }

  function promptNew(kind: 'file' | 'folder') {
    const dir = targetDir()
    if (dir === null) return
    nameModal = {
      title: kind === 'file' ? 'New File' : 'New Folder',
      initial: kind === 'file' ? 'untitled.md' : '',
      confirmLabel: 'Create',
      selectTo: kind === 'file' ? stemLength('untitled.md') : null,
      onConfirm: (value) => {
        nameModal = null
        if (kind === 'file') performCreateFile(dir, value)
        else performCreateFolder(dir, value)
      },
    }
  }

  function startRename(path: string) {
    // Expand every collapsed ancestor first (VS Code behavior): the rename
    // input only exists for VISIBLE rows, so arming a hidden one would leave
    // an input that mounts later, steals focus, and can commit stale.
    const root = get(workspace).root
    if (root !== null) for (const dir of ancestorDirs(root, path)) collapsed[dir] = false
    renameValue = basename(path)
    renaming = path
  }

  // A workspace switch invalidates any in-flight rename — the armed path
  // belongs to the OLD tree, and its input could otherwise mount against an
  // unrelated same-named row later. Tracked against the ROOT only: refreshes
  // of the same folder (refocus, file ops) must not cancel the user's typing.
  let renameRoot: string | null = get(workspace).root
  $effect(() => {
    if ($workspace.root !== renameRoot) {
      renameRoot = $workspace.root
      renaming = null
    }
  })

  // Focus the fresh rename input and preselect the stem (files) or the whole
  // name (folders) — Svelte action, runs once per input mount.
  function renameSetup(node: HTMLInputElement, selectTo: number | null) {
    node.focus()
    if (selectTo !== null) node.setSelectionRange(0, selectTo)
    else node.select()
  }

  // Commit = performRename, which already retargets the doc/openList/preview
  // and refreshes + reselects. An unchanged or invalid name commits as a
  // cancel (VS Code drops the edit silently; the input's red border already
  // gave live feedback). The `renaming !== path` gate makes this idempotent:
  // Enter/Escape resolve the rename first, and the input's teardown blur
  // then no-ops instead of double-committing.
  function commitRename(path: string) {
    if (renaming !== path) return
    renaming = null
    const next = renameValue.trim()
    if (next === basename(path) || leafNameError(next) !== null) return
    performRename(path, next)
  }

  function onRenameKeydown(e: KeyboardEvent, path: string) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(path)
    } else if (e.key === 'Escape') {
      e.stopPropagation() // keep the window-level Escape handler (find bar) out of it
      renaming = null
    }
  }

  function requestDelete(paths: string[]) {
    if (paths.length === 0) return
    // Confirm before deleting a folder or a multi-item batch; a single file goes
    // straight to Trash (recoverable, matching Finder).
    const needsConfirm = paths.length > 1 || paths.some(isFolder)
    if (!needsConfirm) {
      performDelete(paths)
      return
    }
    const label =
      paths.length > 1
        ? `${paths.length} items`
        : (paths[0].split('/').filter(Boolean).pop() ?? paths[0])
    deleteConfirm = { paths, label }
  }

  function confirmDelete() {
    if (deleteConfirm) performDelete(deleteConfirm.paths)
    deleteConfirm = null
  }

  async function handleAction(action: FileOpAction) {
    const sel = [...$selection]
    switch (action) {
      case 'new-file':
        promptNew('file')
        break
      case 'new-folder':
        promptNew('folder')
        break
      case 'open-tab':
        // "New tab" = pinned AND in this window by definition — `inPlace`
        // bypasses the openMode routing that a plain pinned open honors.
        if (sel.length === 1) onOpenFile(sel[0], { preview: false, inPlace: true })
        break
      case 'open-window':
        // Fire-and-forget: openInNewWindow reports its own errors and never
        // falls back to replacing this window's doc.
        if (sel.length === 1) void openInNewWindow(sel[0])
        break
      case 'open-instance':
        // Spawns a whole new app process for the file (its own allowlist,
        // workspace, and lifecycle). The command re-ensures the grant, so
        // only paths this instance could already read can be handed off.
        if (sel.length === 1) {
          invoke('open_file_new_instance', { path: sel[0] }).catch((e) =>
            reportError(`Could not open a new app instance: ${String(e)}`),
          )
        }
        break
      case 'rename':
        if (sel.length === 1) startRename(sel[0])
        break
      case 'duplicate':
        // Sequential, matching how paste()/performMove() serialize a batch:
        // each performDuplicate() call refreshes the whole tree, so firing
        // them unsequenced races concurrent refreshes against each other.
        for (const p of sel) await performDuplicate(p)
        break
      case 'move':
        if (sel.length >= 1) moveSources = sel
        break
      case 'cut':
        cutSelection()
        break
      case 'copy':
        copySelection()
        break
      case 'paste':
        paste()
        break
      case 'delete':
        requestDelete(sel)
        break
      case 'select-all':
        selectVisible($workspace.tree, collapsed)
        break
      case 'close-folder':
        closeWorkspace()
        break
    }
  }

  // Row click: single-select + focus (the paste/new anchor). A markdown
  // file's single click additionally PREVIEWS it (VS Code semantics: italic
  // strip row, always in-place); the second click of a dblclick no-ops in
  // App (already active), then onFileDblClick pins it.
  function onFileClick(f: WorkspaceFile) {
    focusRow(f.path)
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
    focusRow(d.path)
    collapsed[d.path] = !collapsed[d.path]
  }

  // Right-click on a tree row: Finder semantics — keep the selection if the
  // target is in it (act on the multi-selection), otherwise select just the
  // target. `focused` always moves to the target (paste/new anchor). Then the
  // same FileOpsMenu opens at the cursor. stopPropagation keeps the panel-
  // level clearing handler from undoing the selection we just set.
  function onRowContextMenu(e: MouseEvent, path: string) {
    e.preventDefault()
    e.stopPropagation()
    selection.set(selectionForContextMenu(get(selection), path))
    focused.set(path)
    menuOpen = false
    ctxMenu = { x: e.clientX, y: e.clientY }
  }

  // Press on bare panel space (no button ancestor): deselect everything.
  // Covers both mouse buttons; the row/menu/header buttons never match.
  function onPanelPointerDown(e: PointerEvent) {
    if (isSelectionClearingTarget(e.target as HTMLElement)) clearSelection()
  }

  // Right-click on bare panel space: deselect, no menu (spec: menu on rows
  // only). The rename input is exempt entirely — it keeps the native
  // copy/paste menu (contextMenu.ts whitelists INPUT at the window level,
  // and this panel handler must not preventDefault it away).
  function onPanelContextMenu(e: MouseEvent) {
    if ((e.target as HTMLElement | null)?.closest?.('.rename-input')) return
    e.preventDefault()
    if (isSelectionClearingTarget(e.target as HTMLElement)) clearSelection()
  }

  // Whether any document is open at all -- used below to choose between the
  // quiet "Open Folder" row (a doc is open, no workspace tree) and the full
  // empty-state panel (nothing open anywhere).
  let docOpen = $derived(activePath !== null)

  // Whether the workspace tree has any rows at all -- shared by both
  // FileOpsMenu instances (header dropdown + row context menu) to decide
  // whether Select All has anything to select.
  let hasRows = $derived(
    ($workspace.tree?.dirs.length ?? 0) + ($workspace.tree?.files.length ?? 0) > 0,
  )

  function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path
  }
</script>

{#snippet fileRow(f: WorkspaceFile)}
  {#if renaming === f.path}
    <!-- Inline rename swaps the row's <button> for a div: an input inside a
         button is invalid HTML. The .rename-input class is load-bearing —
         isSelectionClearingTarget matches it so caret clicks don't deselect. -->
    <div class="file-row renaming">
      <span class="active-bar"></span>
      <Icon name={fileIcon(f.name)} size={16} />
      <input
        class="rename-input"
        class:invalid={leafNameError(renameValue) !== null}
        bind:value={renameValue}
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
      aria-current={f.path === activePath ? 'true' : undefined}
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
  {#if renaming === d.path}
    <!-- Same div-for-button swap as the file row; folders preselect the whole
         name (no extension stem to protect). -->
    <div class="folder-row renaming">
      <span class="chevron" class:open={!collapsed[d.path]}>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={folderIcon(!collapsed[d.path])} size={16} />
      <input
        class="rename-input"
        class:invalid={leafNameError(renameValue) !== null}
        bind:value={renameValue}
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
      aria-expanded={!collapsed[d.path]}
      onclick={() => onFolderClick(d)}
      oncontextmenu={(e) => onRowContextMenu(e, d.path)}
    >
      <span class="chevron" class:open={!collapsed[d.path]}>
        <Icon name="chevron-right" size={12} />
      </span>
      <Icon name={folderIcon(!collapsed[d.path])} size={16} />
      <span class="name">{d.name}</span>
    </button>
  {/if}
  {#if !collapsed[d.path]}
    <div class="indent">
      {#each d.dirs as sub (sub.path)}{@render dirRows(sub)}{/each}
      {#each d.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {/if}
{/snippet}

<nav
  class="sidebar"
  aria-label="Workspace"
  onpointerdown={onPanelPointerDown}
  oncontextmenu={onPanelContextMenu}
>
  {#if openFiles.length > 0 || previewRow !== null}
    <!-- VS Code "Open Editors"-style strip: every opened document, in- or
         out-of-workspace, so there's one consistent surface for "what's on
         screen" rather than the tree alone. Paths-only --
         the single-doc model is unchanged, this is just a switch list. -->
    <div class="header">
      <span class="label">Open Files</span>
    </div>
    <div class="tree">
      {#each openFiles as path (path)}
        <!-- Two sibling buttons, not a nested button-in-button: the row opens
             the file, the small trailing button closes it (stopPropagation
             so a close click never also switches to it first). -->
        <div class="open-file-row" class:active={path === activePath}>
          <button
            class="open-file-main"
            aria-current={path === activePath ? 'true' : undefined}
            onclick={() => onOpenFile(path)}
          >
            <span class="active-bar"></span>
            <Icon name={fileIcon(basename(path))} size={16} />
            <span class="name">{basename(path)}</span>
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
        <!-- The single-click preview: ONE italic row after the pinned ones.
             Clicking it re-asserts the preview (a no-op while it's already
             the active doc) rather than pinning — only a tree dblclick, an
             explicit open, or editing the buffer promotes it. The italics are
             invisible to a screen reader, so both aria-labels carry the
             "(preview)" state in words. Enter on the already-active row PINS
             it — the keyboard's promotion affordance, mirroring the mouse's
             dblclick (preventDefault keeps the button's synthetic click, which
             would merely re-preview, from also firing). -->
        <div class="open-file-row preview" class:active={pv === activePath}>
          <button
            class="open-file-main"
            aria-label="{basename(pv)} (preview)"
            aria-current={pv === activePath ? 'true' : undefined}
            onclick={() => onOpenFile(pv, { preview: true })}
            onkeydown={(e) => {
              if (e.key === 'Enter' && pv === activePath) {
                e.preventDefault()
                onOpenFile(pv, { preview: false, inPlace: true })
              }
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
  <div class="header">
    <span class="label">Workspace</span>
    <div class="header-actions">
      <button class="new-file" aria-label="New file" onclick={onNewFile}>
        <Icon name="file-plus" size={14} />
      </button>
      <div class="fileops-anchor">
        <button
          class="new-file"
          aria-label="File operations"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={() => { ctxMenu = null; menuOpen = !menuOpen }}
        >
          <Icon name="ellipsis" size={14} />
        </button>
        {#if menuOpen}
          <FileOpsMenu
            {hasRows}
            onAction={handleAction}
            onClose={() => (menuOpen = false)}
          />
        {/if}
      </div>
    </div>
  </div>
  {#if ctxMenu}
    <FileOpsMenu
      {hasRows}
      at={ctxMenu}
      onAction={handleAction}
      onClose={() => (ctxMenu = null)}
    />
  {/if}
  {#if $workspace.tree}
    <div class="tree">
      {#each $workspace.tree.dirs as d (d.path)}{@render dirRows(d)}{/each}
      {#each $workspace.tree.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {:else if docOpen}
    <!-- A file is open: the big empty-state panel would just shout at a user
         who is already reading a document, so offer a quiet row instead. -->
    <button class="open-folder-row" onclick={openWorkspace}>
      <Icon name="folder" size={14} />
      Open Folder…
    </button>
  {:else}
    <!-- Nothing open at all: an always-visible sidebar (rather than one that
         only appears once a folder is picked) teaches the feature on first
         run, matching the design's populated state -- this empty panel is
         its unpopulated counterpart, not a hidden mode. -->
    <div class="empty">
      <span class="empty-icon"><Icon name="folder-open" size={28} /></span>
      <p class="empty-title">No folder open</p>
      <p class="empty-body">Open a folder to browse its markdown files here.</p>
      <button class="open-folder" onclick={openWorkspace}>
        <Icon name="folder" size={14} />
        Open Folder
      </button>
    </div>
  {/if}
</nav>

{#if nameModal}
  <NameModal
    title={nameModal.title}
    initial={nameModal.initial}
    confirmLabel={nameModal.confirmLabel}
    selectTo={nameModal.selectTo}
    onConfirm={nameModal.onConfirm}
    onCancel={() => (nameModal = null)}
  />
{/if}

{#if moveSources}
  <MoveToModal
    sources={moveSources}
    onConfirm={(destDir) => {
      const s = moveSources
      moveSources = null
      if (s) performMove(s, destDir)
    }}
    onCancel={() => (moveSources = null)}
  />
{/if}

{#if deleteConfirm}
  <div class="modal-backdrop" use:portal>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      use:focusTrap
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          deleteConfirm = null
        }
      }}
    >
      <p>Move <strong>{deleteConfirm.label}</strong> to the Trash?</p>
      <div class="actions">
        <button data-autofocus onclick={() => (deleteConfirm = null)}>Cancel</button>
        <button class="danger" onclick={confirmDelete}>Move to Trash</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 12px;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
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
  .new-file {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fg-faint);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .new-file:hover {
    background: var(--surface-hover);
    color: var(--fg-secondary);
  }
  .new-file:active {
    background: var(--surface-active);
  }
  .header-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  /* Positioning context for the FileOpsMenu dropdown anchored under the button. */
  .fileops-anchor {
    position: relative;
    display: inline-flex;
  }

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

  /* Open Files row: two sibling buttons (open-file-main + close-file) inside
     a plain div, not a nested button-in-button. Matches .file-row's look but
     the row itself carries no click handler -- only its children do. */
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

  /* Ghost panel shown when no workspace is open -- discoverable entry point
     for openWorkspace() beyond the File menu. */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 4px;
    padding: 24px 12px;
    margin-top: 12px;
  }
  .empty-icon {
    display: inline-flex;
    color: var(--fg-faint);
    opacity: 0.6;
    margin-bottom: 8px;
  }
  .empty-title {
    margin: 0;
    font: 600 13px var(--font-ui);
    color: var(--fg-secondary);
  }
  .empty-body {
    margin: 0 0 12px;
    font: 400 12px var(--font-ui);
    color: var(--fg-faint);
  }
  .open-folder {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 0;
    border-radius: 6px;
    background: var(--accent-solid);
    color: var(--on-accent);
    font: 600 12px var(--font-ui);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }
  .open-folder:hover {
    background: var(--accent-solid-hover);
  }
  .open-folder:active {
    background: var(--accent-solid-active);
  }

  /* Quiet inline variant shown when a document is already open. */
  .open-folder-row {
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
  .open-folder-row:hover {
    background: var(--surface);
    color: var(--fg-secondary);
  }

  /* Delete confirmation modal (folder or multi-item deletes). Mirrors the
     App.svelte unsaved-changes modal so the two read as one system. */
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
  .modal p {
    margin: 0;
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
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
  }
  .actions button:hover {
    background: var(--surface-hover);
  }
  .actions .danger {
    background: transparent;
    border-color: var(--danger);
    color: var(--danger);
  }
  .actions .danger:hover {
    background: var(--danger-tint);
  }
</style>
