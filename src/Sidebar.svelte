<script lang="ts">
  import Icon from './Icon.svelte'
  import FileOpsMenu, { type FileOpAction } from './FileOpsMenu.svelte'
  import NameModal from './NameModal.svelte'
  import MoveToModal from './MoveToModal.svelte'
  import {
    workspace,
    isMarkdownFile,
    fileIcon,
    folderIcon,
    openWorkspace,
    type WorkspaceDir,
    type WorkspaceFile,
  } from './lib/workspace'
  import {
    selection,
    focused,
    clipboard,
    focusRow,
    cutSelection,
    copySelection,
    selectVisible,
    paste,
    performCreateFile,
    performCreateFolder,
    performRename,
    performDuplicate,
    performMove,
    performDelete,
    pasteTargetDir,
    folderPaths,
  } from './lib/fileops'
  import { isInsideRoot } from './lib/ui'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'

  interface Props {
    activePath: string | null
    onOpenFile: (path: string) => void
    onNewFile: () => void
  }
  let { activePath, onOpenFile, onNewFile }: Props = $props()

  // Collapse state keyed by dir path. Absent/false = expanded (matches the
  // design's open folders); toggled per folder, local to this component.
  let collapsed = $state<Record<string, boolean>>({})

  // File-operations menu + modal state (local to the sidebar chrome).
  let menuOpen = $state(false)
  let nameModal = $state<{
    title: string
    initial: string
    confirmLabel: string
    selectTo: number | null
    onConfirm: (value: string) => void
  } | null>(null)
  let moveSources = $state<string[] | null>(null)
  let deleteConfirm = $state<{ paths: string[]; label: string } | null>(null)

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

  function promptRename(path: string) {
    const name = path.split('/').filter(Boolean).pop() ?? ''
    nameModal = {
      title: 'Rename',
      initial: name,
      confirmLabel: 'Rename',
      selectTo: isFolder(path) ? null : stemLength(name),
      onConfirm: (value) => {
        nameModal = null
        performRename(path, value)
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
      case 'rename':
        if (sel.length === 1) promptRename(sel[0])
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
    }
  }

  // Row click: single-select + focus (the paste/new anchor). Markdown files
  // additionally open through the guarded path in App; folders also toggle.
  function onFileClick(f: WorkspaceFile) {
    focusRow(f.path)
    if (isMarkdownFile(f.name)) onOpenFile(f.path)
  }
  function onFolderClick(d: WorkspaceDir) {
    focusRow(d.path)
    collapsed[d.path] = !collapsed[d.path]
  }

  // A file opened without (or outside) a workspace grant still has an open
  // doc but no tree row to show it in -- surface it as its own "Open File"
  // section (VS Code Open Editors-style) instead of leaving the sidebar
  // silent about what's on screen. Never expands the filesystem allowlist:
  // this only reads $workspace.root, already granted by openWorkspace().
  let showOpenFile = $derived(
    activePath !== null && ($workspace.root === null || !isInsideRoot(activePath, $workspace.root)),
  )
  let openFileName = $derived(activePath?.split('/').filter(Boolean).pop() ?? activePath ?? '')
</script>

{#snippet fileRow(f: WorkspaceFile)}
  <button
    class="file-row"
    class:active={f.path === activePath}
    class:selected={$selection.has(f.path) && f.path !== activePath}
    class:cut={cutSet.has(f.path)}
    aria-current={f.path === activePath ? 'true' : undefined}
    onclick={() => onFileClick(f)}
  >
    <span class="active-bar"></span>
    <Icon name={fileIcon(f.name)} size={16} />
    <span class="name">{f.name}</span>
  </button>
{/snippet}

{#snippet dirRows(d: WorkspaceDir)}
  <button
    class="folder-row"
    class:selected={$selection.has(d.path)}
    class:cut={cutSet.has(d.path)}
    aria-expanded={!collapsed[d.path]}
    onclick={() => onFolderClick(d)}
  >
    <span class="chevron" class:open={!collapsed[d.path]}>
      <Icon name="chevron-right" size={12} />
    </span>
    <Icon name={folderIcon(!collapsed[d.path])} size={16} />
    <span class="name">{d.name}</span>
  </button>
  {#if !collapsed[d.path]}
    <div class="indent">
      {#each d.dirs as sub (sub.path)}{@render dirRows(sub)}{/each}
      {#each d.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {/if}
{/snippet}

<nav class="sidebar" aria-label="Workspace">
  {#if showOpenFile}
    <div class="header">
      <span class="label">Open File</span>
    </div>
    <div class="tree">
      <div class="file-row active static" aria-current="true">
        <span class="active-bar"></span>
        <Icon name={fileIcon(openFileName)} size={16} />
        <span class="name">{openFileName}</span>
      </div>
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
          onclick={() => (menuOpen = !menuOpen)}
        >
          <Icon name="ellipsis" size={14} />
        </button>
        {#if menuOpen}
          <FileOpsMenu
            hasRows={($workspace.tree?.dirs.length ?? 0) + ($workspace.tree?.files.length ?? 0) > 0}
            onAction={handleAction}
            onClose={() => (menuOpen = false)}
          />
        {/if}
      </div>
    </div>
  </div>
  {#if $workspace.tree}
    <div class="tree">
      {#each $workspace.tree.dirs as d (d.path)}{@render dirRows(d)}{/each}
      {#each $workspace.tree.files as f (f.path)}{@render fileRow(f)}{/each}
    </div>
  {:else if showOpenFile}
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
  .file-row:not(.active):not(.static):hover {
    background: var(--surface-hover);
    color: var(--fg-secondary);
  }
  .file-row:not(.active):not(.static):active {
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
  /* The "Open File" row is not a button -- it's already the open doc, so
     clicking it is a no-op. Same active styling, but no pointer affordance. */
  .file-row.static {
    cursor: default;
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
