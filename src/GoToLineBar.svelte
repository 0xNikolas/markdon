<script lang="ts">
  import { doc } from './lib/doc'
  import { split, closeGoto } from './lib/ui'
  import { goToSourceLine, clearPendingLine } from './lib/sourceEditor'
  import { parseGoto, lineCount } from './lib/gotoLine'
  import { focusTrap } from './lib/focusTrap'
  import { portal } from './lib/portal'
  import { get } from 'svelte/store'

  let value = $state('')
  let error = $state(false)
  let inputEl = $state<HTMLInputElement>()

  $effect(() => {
    inputEl?.focus()
  })

  const total = $derived(lineCount($doc.content))

  function submit() {
    const trimmed = value.trim()
    if (trimmed === '') {
      closeGoto()
      return
    }
    const t = parseGoto(trimmed)
    if (!t) {
      error = true
      return
    }
    error = false
    // WYSIWYG has no line concept: reveal split mode first, then jump in the
    // CodeMirror source pane. goToSourceLine no-ops-and-queues if the source
    // pane hasn't mounted yet (queued jump flushes on SourcePane mount).
    if (!get(split)) split.set(true)
    goToSourceLine(t.line, t.col)
    closeGoto()
  }

  function onInput(e: Event) {
    value = (e.currentTarget as HTMLInputElement).value
    error = false
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  // A jump not yet flushed (queued because split hadn't mounted its source
  // pane yet) must be dropped on dismiss, so a later unrelated source-pane
  // mount can't fire a stale caret jump.
  function close() {
    clearPendingLine()
    closeGoto()
  }

  // Outside-click dismiss (mirrors FileOpsMenu's onWindowPointerDown pattern
  // rather than a clickable backdrop div, which would need its own a11y
  // role/keyboard handling for no benefit -- Esc already covers dismissal).
  let popoverEl = $state<HTMLElement>()
  function onWindowPointerDown(e: PointerEvent) {
    if (popoverEl && !popoverEl.contains(e.target as Node)) close()
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="backdrop" use:portal>
  <div
    bind:this={popoverEl}
    class="popover"
    role="dialog"
    aria-modal="true"
    aria-label="Go to Line"
    tabindex="-1"
    use:focusTrap
    onkeydown={onKeydown}
  >
    <input
      bind:this={inputEl}
      type="text"
      value={value}
      oninput={onInput}
      placeholder="Line, or line:col"
      aria-label="Line, or line:col"
      aria-invalid={error}
      data-autofocus
      class:error
    />
    <span class="hint">{error ? 'Invalid line' : `1–${total}`}</span>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
  }
  .popover {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--modal-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-popover);
    font: 13px var(--font-ui);
  }
  input {
    width: 220px;
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
  input.error {
    border-color: var(--danger);
  }
  .hint {
    flex-shrink: 0;
    color: var(--fg-muted);
  }
  input.error + .hint {
    color: var(--danger);
  }
</style>
