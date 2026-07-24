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
  import { selection, clipboard } from './lib/fileOpsState'
  import { folderPaths } from './lib/fileTree'
  import { workspace, isMarkdownFile, isImageFile } from './lib/workspace'
  import { fileMenuVisibility } from './lib/sidebarMenu'
  import { basename } from './lib/paths'
  import ContextMenu, { type MenuItem } from './ContextMenu.svelte'

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
  let singleName = $derived(singlePath ? basename(singlePath) : '')
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

  let items = $derived<MenuItem<FileOpAction>[]>([
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
</script>

<ContextMenu {items} {at} ariaLabel="File operations" {onClose} onSelect={onAction} />
