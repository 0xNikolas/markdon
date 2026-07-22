<script lang="ts">
  import {
    searchUi,
    setQuery,
    findNext,
    findPrev,
    closeFind,
    setCaseSensitive,
    setWholeWord,
    replaceOne,
    replaceAll,
    shouldFocusFind,
  } from './lib/searchPlugin'
  import { doc } from './lib/doc'
  import Icon from './Icon.svelte'

  let inputEl: HTMLInputElement | undefined = $state()

  // Focus the find input only on the false->true transition of `open` --
  // see shouldFocusFind's doc comment for why a bare `if ($searchUi.open)`
  // is wrong here (it would re-focus on every searchUi.update(), including
  // the ones this commit added for chip clicks / replace / the chevron).
  let wasOpen = false
  $effect(() => {
    const isOpen = $searchUi.open
    if (shouldFocusFind(wasOpen, isOpen)) inputEl?.focus()
    wasOpen = isOpen
  })

  function onInput(e: Event) {
    setQuery((e.currentTarget as HTMLInputElement).value)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrev()
      else findNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    }
  }

  let replaceValue = $state('')

  // Enter in the replace field = Replace one (mirrors CM's own panel);
  // Cmd/Ctrl+Enter or the Replace All button = Replace All.
  function onReplaceKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (e.metaKey || e.ctrlKey) replaceAll(replaceValue)
    else replaceOne(replaceValue)
  }

  function toggleReplaceRow() {
    searchUi.update((ui) => ({ ...ui, replaceOpen: !ui.replaceOpen }))
  }
</script>

<div class="find-bar" role="search">
  <div class="row">
    <button
      class="disclosure"
      aria-label={$searchUi.replaceOpen ? 'Hide replace' : 'Show replace'}
      aria-expanded={$searchUi.replaceOpen}
      onclick={toggleReplaceRow}
    >
      <Icon name={$searchUi.replaceOpen ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>
    <input
      bind:this={inputEl}
      type="text"
      value={$searchUi.query}
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="Find"
      aria-label="Find in document"
    />
    <button
      class="chip"
      role="switch"
      aria-checked={$searchUi.caseSensitive}
      aria-label="Match case"
      title="Match case"
      onclick={() => setCaseSensitive(!$searchUi.caseSensitive)}
    >
      Aa
    </button>
    <button
      class="chip"
      role="switch"
      aria-checked={$searchUi.wholeWord}
      aria-label="Match whole word"
      title="Match whole word"
      onclick={() => setWholeWord(!$searchUi.wholeWord)}
    >
      W
    </button>
    <span class="count" aria-live="polite">
      {#if $searchUi.query.length > 0}
        {$searchUi.count > 0 ? `${$searchUi.activeIndex + 1} of ${$searchUi.count}` : 'No matches'}
      {/if}
    </span>
    <button aria-label="Previous match" disabled={$searchUi.count === 0} onclick={findPrev}>‹</button>
    <button aria-label="Next match" disabled={$searchUi.count === 0} onclick={findNext}>›</button>
    <button aria-label="Close find bar" onclick={closeFind}>✕</button>
  </div>
  {#if $searchUi.replaceOpen}
    <div class="row replace-row">
      <span class="spacer" aria-hidden="true"></span>
      <input
        type="text"
        value={replaceValue}
        oninput={(e) => (replaceValue = (e.currentTarget as HTMLInputElement).value)}
        onkeydown={onReplaceKeydown}
        placeholder="Replace"
        aria-label="Replace with"
        disabled={$doc.readonly}
      />
      <button disabled={$doc.readonly || $searchUi.count === 0} onclick={() => replaceOne(replaceValue)}>
        Replace
      </button>
      <button disabled={$doc.readonly || $searchUi.count === 0} onclick={() => replaceAll(replaceValue)}>
        Replace All
      </button>
    </div>
  {/if}
</div>

<style>
  .find-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 12px;
    background: var(--bg);
    color: var(--fg);
    font: 13px var(--font-ui);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    max-width: 260px;
    font: inherit;
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    padding: 3px 8px;
  }
  input:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .count {
    flex-shrink: 0;
    min-width: 5.5em;
    color: var(--fg-muted);
  }
  button {
    font: 15px inherit;
    color: inherit;
    background: transparent;
    border: none;
    border-radius: 4px;
    padding: 2px 4px;
    cursor: pointer;
    line-height: 1;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  button:not(:disabled):hover {
    background: var(--surface-hover);
  }
  button:not(:disabled):active {
    background: var(--surface-active);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Leading disclosure chevron: toggles the replace row. */
  .disclosure {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    color: var(--fg-muted);
  }

  /* Aa / W option chips: compact switches, matching find-bar density more
     than SettingsModal's full toggle. Active state uses --accent-tint per
     the existing settings-toggle a11y convention (bare --accent text/bg
     doesn't clear 4.5:1 in both themes; --accent-tint-fg does). */
  .chip {
    flex-shrink: 0;
    font: 12px var(--font-ui);
    font-weight: 600;
    padding: 2px 6px;
    border: 1px solid transparent;
  }
  .chip[aria-checked='true'] {
    background: var(--accent-tint);
    color: var(--accent-tint-fg);
    border-color: var(--accent-tint-strong);
  }
  .chip[aria-checked='true']:hover {
    background: var(--accent-tint-strong);
  }

  /* Replace row lines its input up under the find input: the disclosure
     chevron's width + row gap. */
  .spacer {
    flex-shrink: 0;
    width: 20px;
  }
  .replace-row button {
    flex-shrink: 0;
    font: 12px var(--font-ui);
    padding: 3px 10px;
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 6px;
  }
  .replace-row button:not(:disabled):hover {
    background: var(--surface-hover);
  }
  .replace-row button:not(:disabled):active {
    background: var(--surface-active);
  }
</style>
