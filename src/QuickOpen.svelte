<script lang="ts">
  import { doc } from './lib/doc'
  import { workspace } from './lib/workspace'
  import { openList, previewPath } from './lib/openList'
  import { recencyOf } from './lib/recency'
  import { closeOverlay } from './lib/overlay'
  import { quickOpenSections } from './lib/quickOpen'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'

  /**
   * The ⌘P Quick Open palette (VS Code's Go to File), mounted by App.svelte
   * while the 'quickopen' overlay is active. Two recency-sorted sections
   * (lib/quickOpen.ts owns flattening, sectioning and ranking): 'Open Files'
   * — the strip's rows, most recent first, active last on the empty query —
   * then 'Workspace' with every other markdown file. Typing fuzzy-filters
   * WITHIN each section (an empty section hides, header included),
   * ArrowUp/Down move the selection across sections as one flat list
   * (headers are skipped by construction — they are never options), Enter
   * hands the pick to App (which closes the overlay FIRST, then opens pinned
   * in place), and Escape / Backspace-on-empty-input / an outside click
   * dismiss.
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

  // $doc.path threads the active file through so the empty query ranks it
  // last within Open Files (see quickOpenSections) — the file you're in is
  // the least likely jump target. `recencyOf` is read non-reactively: any
  // recency change comes from a doc load, and every doc load closes this
  // palette, so a stale read while it is open is impossible.
  const sections = $derived(
    quickOpenSections(query, $workspace.tree, $openList, $previewPath, $doc.path, recencyOf),
  )
  // The keyboard cursor runs over this FLAT list — section headers are not
  // part of it, so arrowing skips them by construction.
  const results = $derived(sections.flatMap((s) => s.items))
  // Each section's first flat index, aligned with `sections` — the markup
  // renders per-section but ids/selection stay flat-indexed.
  const sectionStarts = $derived.by(() => {
    const starts: number[] = []
    let sum = 0
    for (const s of sections) {
      starts.push(sum)
      sum += s.items.length
    }
    return starts
  })
  // Clamped view of the keyboard cursor: a shrinking result list (typing, or
  // a workspace refresh mid-palette) must never leave it past the end.
  const activeIndex = $derived(Math.max(0, Math.min(selected, results.length - 1)))

  function onInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value
    selected = 0 // every query edit restarts the selection at the best match
  }

  // Keep the selected row on-screen while arrowing through the scrolling
  // list — by id, not child index: headers sit between the option rows.
  $effect(() => {
    listEl?.querySelector(`#quick-open-item-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
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
        {#each sections as sec, si (sec.label)}
          <!-- Non-interactive section header, eyebrow-styled (EmptyState's
               'Recent' label). role=presentation over role=group wrappers:
               grouping would nest the options a level deeper and fight the
               flat activedescendant/id indexing for no AT win — a
               presentation row simply drops out of the listbox's semantics
               (never an option, so the keyboard cursor can't land on it). -->
          <li class="section-label" role="presentation">{sec.label}</li>
          {#each sec.items as r, j (r.path)}
            {@const i = sectionStarts[si] + j}
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
  /* Section header: EmptyState's .eyebrow, so the two read as one system. */
  .section-label {
    padding: 6px 8px 2px;
    font: 600 11px var(--font-ui);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-faint);
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
