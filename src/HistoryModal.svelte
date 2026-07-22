<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import ReadonlyMarkdown from './ReadonlyMarkdown.svelte'
  import { closeOverlay } from './lib/overlay'
  import { logWarn } from './lib/logging'
  import { focusTrap, dialogDismissHandlers } from './lib/focusTrap'
  import {
    loadVersions,
    readVersion,
    relativeTime,
    sizeDelta,
    triggerLabel,
    type HistoryEntry,
  } from './lib/history'

  // File History modal. Left: the version list, newest-first. Right: a
  // read-only render of the selected version. Footer reverts the selected version
  // INTO THE BUFFER as unsaved changes (App.svelte's applyRevert routes through
  // the discard guard); disk truth is untouched until the user saves.
  interface Props {
    path: string | null
    // Read-only docs: revert implies edit intent, so the Revert
    // button is disabled while the buffer is locked (App.svelte drives this
    // from $doc.readonly). Viewing history stays allowed.
    readonly?: boolean
    onRevert: (content: string) => void
  }
  let { path, readonly = false, onRevert }: Props = $props()

  let entries = $state<HistoryEntry[]>([])
  let selectedId = $state<string | null>(null)
  let selectedContent = $state<string>('')
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  // Captured once so relative-time labels stay stable while the modal is open.
  const now = Date.now()

  onMount(async () => {
    if (path === null) {
      loading = false
      return
    }
    try {
      const list = await loadVersions(path)
      entries = list
      if (list.length > 0) await select(list[0].id)
    } catch (e) {
      loadError = `Could not load history: ${String(e)}`
      logWarn('history modal load failed', e)
    } finally {
      loading = false
    }
  })

  async function select(id: string) {
    if (path === null) return
    selectedId = id
    try {
      selectedContent = await readVersion(path, id)
      loadError = null
    } catch (e) {
      selectedContent = ''
      loadError = `Could not read this version: ${String(e)}`
      logWarn('history version read failed', e)
    }
  }

  // entries are newest-first, so a version's PREVIOUS (older) sibling is the next
  // index; its size drives the delta column. The oldest row has no previous.
  function prevSize(i: number): number | null {
    return i + 1 < entries.length ? entries[i + 1].size : null
  }

  function revert() {
    if (selectedId === null || readonly) return // button is disabled while readonly; guard anyway
    onRevert(selectedContent) // App.svelte: guarded() -> recordRevert -> revertBuffer -> close
  }

  const { onKeydown: onDialogKeydown, onBackdropClick } = dialogDismissHandlers(closeOverlay)

  const hasHistory = $derived(entries.length > 0)
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onBackdropClick}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="history-title"
    tabindex="-1"
    use:focusTrap
    onkeydown={onDialogKeydown}
  >
    <div class="header">
      <span class="title-icon" aria-hidden="true"><Icon name="history" size={16} /></span>
      <h2 id="history-title">File History</h2>
      <button class="close" aria-label="Close file history" onclick={closeOverlay}>
        <Icon name="x" size={16} />
      </button>
    </div>

    {#if path === null}
      <div class="empty">
        <p class="empty-title">No history yet</p>
        <p class="empty-hint">Save this file to start tracking versions.</p>
      </div>
    {:else if loading}
      <div class="empty"><p class="empty-hint">Loading…</p></div>
    {:else if !hasHistory}
      <div class="empty">
        <p class="empty-title">No versions saved yet</p>
        <p class="empty-hint">
          A version is recorded each time this file’s content changes on save.
        </p>
      </div>
    {:else}
      <div class="body">
        <ul class="versions" role="listbox" aria-label="Saved versions" tabindex="-1">
          {#each entries as entry, i (entry.id)}
            <li role="presentation">
              <button
                role="option"
                aria-selected={entry.id === selectedId}
                class="version-row"
                class:active={entry.id === selectedId}
                data-autofocus={i === 0 ? true : undefined}
                title={new Date(entry.ts).toLocaleString()}
                onclick={() => select(entry.id)}
              >
                <span class="row-top">
                  <span class="time">{relativeTime(entry.ts, now)}</span>
                  <span class="badge {entry.trigger}">{triggerLabel(entry.trigger)}</span>
                </span>
                <span class="row-bottom">
                  <span class="preview">{entry.preview || 'Untitled version'}</span>
                  <span class="delta">{sizeDelta(entry.size, prevSize(i))}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>

        <div class="preview-pane">
          {#if loadError !== null}
            <div class="pane-error" role="alert">{loadError}</div>
          {:else}
            {#key selectedId}
              <ReadonlyMarkdown content={selectedContent} />
            {/key}
          {/if}
        </div>
      </div>

      <div class="footer">
        <p class="footer-note">
          Reverting loads this version as unsaved changes — save to keep it.
        </p>
        <div class="footer-actions">
          <button class="secondary" onclick={closeOverlay}>Close</button>
          <button
            class="primary"
            disabled={selectedId === null || readonly}
            title={readonly ? 'Enable editing first' : undefined}
            onclick={revert}
          >
            Revert to this version
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    display: flex;
    flex-direction: column;
    width: 860px;
    height: 560px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 40px);
    border-radius: 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    flex-shrink: 0;
    padding: 0 16px;
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--border);
  }
  .title-icon {
    display: inline-flex;
    color: var(--fg-secondary);
  }
  .header h2 {
    margin: 0;
    flex: 1;
    font: 700 15px var(--font-ui);
    color: var(--fg-strong);
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .close:hover {
    background: var(--surface-hover);
    color: var(--fg-strong);
  }
  .close:active {
    background: var(--surface-active);
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 32px;
    text-align: center;
  }
  .empty-title {
    margin: 0;
    font: 600 15px var(--font-ui);
    color: var(--fg-strong);
  }
  .empty-hint {
    margin: 0;
    font: 400 13px/1.5 var(--font-ui);
    color: var(--fg-muted);
    max-width: 340px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .versions {
    width: 300px;
    flex-shrink: 0;
    margin: 0;
    padding: 8px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    background: var(--surface-sunken);
    border-right: 1px solid var(--border);
  }
  .version-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }
  .version-row:hover {
    background: var(--surface-hover);
  }
  .version-row.active {
    background: var(--surface);
    border-color: var(--surface-border);
  }
  .row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .time {
    font: 600 12px var(--font-ui);
    color: var(--fg-strong);
  }
  .badge {
    font: 600 10px var(--font-ui);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--surface);
    color: var(--fg-secondary);
    border: 1px solid var(--surface-border);
    flex-shrink: 0;
  }
  .badge.external {
    color: var(--warn-fg);
    background: var(--warn-bg);
    border-color: var(--warn-border);
  }
  .badge.revert {
    color: var(--info-fg);
    background: var(--info-bg);
    border-color: var(--info-border);
  }
  .row-bottom {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .preview {
    font: 400 12px var(--font-ui);
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delta {
    font: 400 11px var(--font-mono);
    color: var(--fg-muted);
    flex-shrink: 0;
  }

  .preview-pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }
  .pane-error {
    padding: 16px;
    font: 400 13px var(--font-ui);
    color: var(--danger);
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-shrink: 0;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .footer-note {
    margin: 0;
    font: 400 12px/1.4 var(--font-ui);
    color: var(--fg-muted);
  }
  .footer-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .footer-actions button {
    padding: 7px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    font: 600 13px var(--font-ui);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
  }
  .secondary {
    background: var(--surface);
    color: var(--fg-secondary);
  }
  .secondary:hover {
    background: var(--surface-hover);
    color: var(--fg-strong);
  }
  .secondary:active {
    background: var(--surface-active);
  }
  /* --accent-solid (not bare --accent): white text on --accent is below WCAG AA;
     --accent-solid and its shades clear 4.5:1+ in both themes. */
  .primary {
    background: var(--accent-solid);
    color: var(--on-accent);
  }
  .primary:not(:disabled):hover {
    background: var(--accent-solid-hover);
  }
  .primary:not(:disabled):active {
    background: var(--accent-solid-active);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
