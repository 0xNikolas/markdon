<script lang="ts">
  import { doc } from './lib/doc'
  import { split } from './lib/ui'
  import { closeOverlay } from './lib/overlay'
  import { goToSourceLine, clearPendingLine } from './lib/sourceEditor'
  import { parseGoto, lineCount } from './lib/gotoLine'
  import Popover from './Popover.svelte'
  import { autofocus } from './lib/autofocus'
  import { get } from 'svelte/store'

  let value = $state('')
  let error = $state(false)

  const total = $derived(lineCount($doc.content))

  function submit() {
    const trimmed = value.trim()
    if (trimmed === '') {
      closeOverlay()
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
    closeOverlay()
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
    closeOverlay()
  }
</script>

<Popover variant="bar" ariaLabel="Go to Line" onDismiss={close} {onKeydown}>
  <input
    use:autofocus
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
</Popover>

<style>
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
