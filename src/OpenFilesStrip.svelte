<script lang="ts">
  import Icon from './Icon.svelte'
  import { fileIcon } from './lib/workspace'
  import { basename } from './lib/treeState'

  interface Props {
    openFiles: string[]
    /** The single-click preview slot (openList.ts) — the strip's italic row. */
    previewPath: string | null
    activePath: string | null
    onOpenFile: (path: string, opts?: { preview?: boolean; inPlace?: boolean }) => void
    onCloseFile: (path: string) => void
  }
  let { openFiles, previewPath, activePath, onOpenFile, onCloseFile }: Props = $props()

  // The italic preview row, rendered only while the previewed path isn't
  // pinned — pinning moves it into openFiles and the slot clears, so a
  // lingering equal value must not draw a duplicate row.
  let previewRow = $derived(
    previewPath !== null && !openFiles.includes(previewPath) ? previewPath : null,
  )
</script>

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
  <div class="tree" data-testid="open-files">
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
</style>
