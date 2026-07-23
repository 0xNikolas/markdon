<script lang="ts">
  import Icon from './Icon.svelte'
  import FileOpsMenu, { type FileOpAction } from './FileOpsMenu.svelte'
  import NameModal from './NameModal.svelte'
  import MoveToModal from './MoveToModal.svelte'
  import OpenFilesStrip, { type StripRowAction } from './OpenFilesStrip.svelte'
  import SidebarHeader from './SidebarHeader.svelte'
  import WorkspaceTree from './WorkspaceTree.svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { workspace, openWorkspace, closeWorkspace } from './lib/workspace'
  import { openInNewWindow } from './lib/files'
  import { reportError } from './lib/errors'
  import {
    selection,
    focused,
    cutSelection,
    copySelection,
    selectVisible,
    clearSelection,
  } from './lib/fileOpsState'
  import {
    paste,
    performCreateFile,
    performCreateFolder,
    performDuplicate,
    performMove,
    performDelete,
  } from './lib/fileMutations'
  import { pasteTargetDir, folderPaths } from './lib/fileTree'
  import { collapsed, startRename, stemLength, basename } from './lib/treeState'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import { get } from 'svelte/store'
  import { selectionForContextMenu, isSelectionClearingTarget } from './lib/sidebarMenu'

  interface Props {
    activePath: string | null
    openFiles: string[]
    /** The single-click preview slot (openList.ts) — the strip's italic row. */
    previewPath: string | null
    /** Paths whose CACHED (background) buffers hold unsaved edits — the
        strip renders a dirty dot on those rows (bufferCache.dirtyCached). */
    dirtyPaths?: ReadonlySet<string>
    /** `preview` = single-click glance (always in-place); `inPlace` = the
        explicit Open in New Tab action, which bypasses openMode routing. */
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    onCloseFile: (path: string) => void
    /** Strip-row context-menu action — semantics live in App.handleStripAction. */
    onStripAction: (action: StripRowAction, path: string) => void
    onNewFile: () => void
  }
  let {
    activePath,
    openFiles,
    previewPath,
    dirtyPaths = new Set(),
    onOpenFile,
    onCloseFile,
    onStripAction,
    onNewFile,
  }: Props = $props()

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

  // Directory a New/Paste lands in: focused folder, focused file's parent, else root.
  function targetDir(): string | null {
    return pasteTargetDir($focused, folderPaths($workspace.tree), $workspace.root)
  }

  function isFolder(path: string): boolean {
    return folderPaths($workspace.tree).has(path)
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
        : basename(paths[0])
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
      case 'open':
        // Open the file in this window: a markdown doc lands in the current
        // tab (inPlace), an image routes to the image view — handleOpenFile
        // detects the image type and diverts before touching $doc, so one
        // call covers both. Non-openable types never reach here (Open hidden).
        if (sel.length === 1) onOpenFile(sel[0], { inPlace: true })
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
      case 'reveal':
        // Reveal in Finder. reveal_path is allowlist-gated in Rust
        // (AllowedPaths::ensure), and opening the workspace already granted its
        // root — so any file inside it, even one only ever LISTED and never
        // opened, is accepted. A file deleted from disk after listing fails
        // ensure's canonicalize and surfaces the banner rather than crashing.
        if (sel.length === 1) {
          invoke('reveal_path', { path: sel[0] }).catch((e) =>
            reportError(`Could not reveal file: ${String(e)}`),
          )
        }
        break
      case 'copy-path':
        // Absolute path to the system clipboard; a denied/unavailable clipboard
        // surfaces honestly rather than silently no-oping (mirrors the strip).
        if (sel.length === 1) {
          navigator.clipboard
            .writeText(sel[0])
            .catch((e) => reportError(`Could not copy path: ${String(e)}`))
        }
        break
      case 'close':
        // Route through App's guarded onCloseFile (dirty-guard + neighbour /
        // empty-state fallback) — the same path the strip's close button uses.
        // Only offered while the file is in the strip (FileOpsMenu gating).
        if (sel.length === 1) onCloseFile(sel[0])
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
        selectVisible($workspace.tree, get(collapsed))
        break
      case 'close-folder':
        closeWorkspace()
        break
    }
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

  // Paths currently in the Open Files strip (pinned rows + the italic preview
  // row) — the row context menu's Close item shows only for a file that's open.
  let openPaths = $derived(
    new Set(previewPath !== null ? [...openFiles, previewPath] : openFiles),
  )
</script>

<nav
  class="sidebar"
  aria-label="Workspace"
  onpointerdown={onPanelPointerDown}
  oncontextmenu={onPanelContextMenu}
>
  <OpenFilesStrip
    {openFiles}
    {previewPath}
    {activePath}
    {dirtyPaths}
    {onOpenFile}
    {onCloseFile}
    {onStripAction}
  />
  <SidebarHeader
    {menuOpen}
    {hasRows}
    {onNewFile}
    onToggleMenu={() => { ctxMenu = null; menuOpen = !menuOpen }}
    onCloseMenu={() => (menuOpen = false)}
    onAction={handleAction}
  />
  {#if ctxMenu}
    <FileOpsMenu
      {hasRows}
      {openPaths}
      at={ctxMenu}
      onAction={handleAction}
      onClose={() => (ctxMenu = null)}
    />
  {/if}
  {#if $workspace.tree}
    <WorkspaceTree {activePath} {onOpenFile} {onRowContextMenu} />
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
