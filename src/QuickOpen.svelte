<script lang="ts">
  import { doc } from './lib/doc'
  import { workspace } from './lib/workspace'
  import { closeOverlay } from './lib/overlay'
  import { flattenMarkdownFiles, fuzzyRank } from './lib/quickOpen'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'

  /**
   * The ⌘P Quick Open palette (VS Code's Go to File), mounted by App.svelte
   * while the 'quickopen' overlay is active. Lists the workspace tree's
   * markdown files (lib/quickOpen.ts owns flattening and ranking); typing
   * fuzzy-filters, ArrowUp/Down move the selection, Enter hands the pick to
   * App (which closes the overlay FIRST, then opens pinned in place), and
   * Escape / Backspace-on-empty-input / an outside click dismiss.
   */
  interface Props {
    onPick: (path: string) => void
  }
  let { onPick }: Props = $props()

  let query = $state('')
  let selected = $state(0)
  let listEl = $state<HTMLElement>()
  let inputEl = $state<HTMLInputElement>()

  // Explicit post-mount focus, exactly like GoToLineBar's: focusTrap's own
  // initial focus can run while the portaled panel isn't laid out yet (its
  // offsetParent gate then skips the input — observed on WebKit when the ⌘P
  // keydown itself triggers the mount), and typing must land in the input.
  $effect(() => {
    inputEl?.focus()
  })

  const items = $derived(flattenMarkdownFiles($workspace.tree))
  // $doc.path threads the active file through so the empty query ranks it
  // last (see fuzzyRank) — the file you're in is the least likely jump target.
  const results = $derived(fuzzyRank(query, items, $doc.path))
  // Clamped view of the keyboard cursor: a shrinking result list (typing, or
  // a workspace refresh mid-palette) must never leave it past the end.
  const activeIndex = $derived(Math.max(0, Math.min(selected, results.length - 1)))

  function onInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value
    selected = 0 // every query edit restarts the selection at the best match
  }

  // Keep the selected row on-screen while arrowing through the scrolling list.
  $effect(() => {
    listEl?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  })

  function move(delta: number) {
    if (results.length === 0) return
    selected = Math.max(0, Math.min(activeIndex + delta, results.length - 1))
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[activeIndex]
      if (r) onPick(r.path)
    } else if (e.key === 'Escape') {
      // stopPropagation mirrors GoToLineBar: the window-level keydown handler
      // must not also act on this Escape.
      e.preventDefault()
      e.stopPropagation()
      closeOverlay()
    } else if (e.key === 'Backspace' && query === '') {
      // Backspace with nothing left to delete backs out of the palette
      // (VS Code doesn't do this; here it makes ⌘P → backspace a clean undo).
      e.preventDefault()
      closeOverlay()
    }
  }

  // Outside-click dismiss (GoToLineBar's onWindowPointerDown pattern — the
  // backdrop is pointer-events:none, so a click outside lands on the app).
  let panelEl = $state<HTMLElement>()
  function onWindowPointerDown(e: PointerEvent) {
    if (panelEl && !panelEl.contains(e.target as Node)) closeOverlay()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="backdrop" use:portal>
  <div
    bind:this={panelEl}
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Quick Open"
    tabindex="-1"
    use:focusTrap
    onkeydown={onKeydown}
  >
    <!-- Combobox pattern: the input stays focused (rows are never tabbable)
         and aria-activedescendant tracks the keyboard selection. -->
    <input
      bind:this={inputEl}
      type="text"
      role="combobox"
      value={query}
      oninput={onInput}
      placeholder="Go to file…"
      aria-label="Go to file"
      aria-expanded="true"
      aria-controls="quick-open-list"
      aria-autocomplete="list"
      aria-activedescendant={results.length > 0 ? `quick-open-item-${activeIndex}` : undefined}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      data-autofocus
    />
    {#if results.length > 0}
      <ul bind:this={listEl} id="quick-open-list" class="list" role="listbox" aria-label="Files">
        {#each results as r, i (r.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- Keyboard interaction lives on the input (combobox pattern);
               pointermove-selects + click-picks mirror a native list. -->
          <li
            id="quick-open-item-{i}"
            role="option"
            aria-selected={i === activeIndex}
            class="row"
            class:selected={i === activeIndex}
            onpointermove={() => (selected = i)}
            onclick={() => onPick(r.path)}
          >
            <span class="name">{r.name}</span>
            {#if r.dir}<span class="dir">{r.dir}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="no-match" role="status">No matching files</p>
    {/if}
  </div>
</div>

<style>
  /* Same shell as GoToLineBar: full-window fixed layer that eats no pointer
     events itself (outside clicks reach the app and dismiss via the window
     pointerdown handler); only the panel is interactive. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
  }
  /* Top-aligned like VS Code's quick pick, sharing GoToLineBar's 64px drop. */
  .panel {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 520px;
    max-width: calc(100vw - 48px);
    box-sizing: border-box;
    padding: 8px;
    background: var(--modal-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-popover);
    font: 13px var(--font-ui);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--surface-border, var(--border));
    border-radius: 6px;
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }
  input:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  /* ~12 rows visible (28px each); the rest scroll. */
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 336px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .row:hover,
  .row.selected {
    background: var(--surface-hover);
  }
  .row.selected:active {
    background: var(--surface-active);
  }
  /* Basename strong + parent path muted — EmptyState's recent-row idiom. */
  .name {
    font-weight: 600;
    color: var(--fg-secondary);
    flex-shrink: 0;
  }
  .row.selected .name {
    color: var(--fg-strong);
  }
  .dir {
    font-size: 12px;
    color: var(--fg-muted);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .no-match {
    margin: 0;
    padding: 2px 8px 4px;
    color: var(--fg-muted);
  }
</style>
