<script lang="ts">
  import { searchUi, setQuery, findNext, findPrev, closeFind } from './lib/searchPlugin'

  let inputEl: HTMLInputElement | undefined = $state()

  // Focus the input whenever the bar opens (Cmd+F while already open is a
  // no-op re-focus, which is harmless).
  $effect(() => {
    if ($searchUi.open) inputEl?.focus()
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
</script>

<div class="find-bar" role="search">
  <input
    bind:this={inputEl}
    type="text"
    value={$searchUi.query}
    oninput={onInput}
    onkeydown={onKeydown}
    placeholder="Find"
    aria-label="Find in document"
  />
  <span class="count" aria-live="polite">
    {#if $searchUi.query.length > 0}
      {$searchUi.count > 0 ? `${$searchUi.activeIndex + 1} of ${$searchUi.count}` : 'No matches'}
    {/if}
  </span>
  <button aria-label="Previous match" disabled={$searchUi.count === 0} onclick={findPrev}>‹</button>
  <button aria-label="Next match" disabled={$searchUi.count === 0} onclick={findNext}>›</button>
  <button aria-label="Close find bar" onclick={closeFind}>✕</button>
</div>

<style>
  .find-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface);
    color: var(--fg);
    font: 13px system-ui, sans-serif;
    border-bottom: 1px solid var(--border);
  }
  input {
    flex: 1;
    min-width: 0;
    max-width: 260px;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
  }
  .count {
    flex-shrink: 0;
    min-width: 5.5em;
    color: inherit;
  }
  button {
    font: 15px inherit;
    color: inherit;
    background: transparent;
    border: none;
    padding: 0 2px;
    cursor: pointer;
    line-height: 1;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
