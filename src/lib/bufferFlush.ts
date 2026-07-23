/**
 * Flush-before-read bridge over the editors' debounced serialization.
 *
 * Neither editor serializes per keystroke: Crepe's hardwired
 * @milkdown/plugin-listener emits markdown on a 200ms trailing debounce, and
 * the split-mode CodeMirror pane batches large docs the same way (see
 * sourceEditor.ts's createDocSync). So `doc.content` can trail the on-screen
 * text by up to one debounce window — continuous typing defers it
 * indefinitely. Any code that READS the buffer to decide or to write — save,
 * export's markdown path, the discard guard's isDirty, external-change
 * classification, the stash-on-switch — must call flushBufferEdits() first so
 * the pending serialization lands before the read. Without it, Cmd+S inside
 * the pending window writes a file that misses the newest keystrokes and the
 * doc re-dirties when the deferred emission lands.
 *
 * Module-singleton slot, same shape as export.ts's registerHtmlSource:
 * whichever editor pane is mounted registers its flush after creation and
 * unregisters on destroy. Only one pane is ever mounted (App's {#if $split}
 * either/or branch), and with none mounted — or nothing pending — the flush
 * is a no-op. The registered fn routes through the SAME onChange path as the
 * editor's own debounced emission, so adoptNormalization/edit semantics hold.
 */

let flush: (() => void) | null = null

/** Re-entrancy latch: a flush that (via edit()'s store fanout) somehow reaches
 * another flushBufferEdits() call must not recurse into the editor. */
let flushing = false

export function registerBufferFlush(fn: () => void): void {
  flush = fn
}

/** Unregisters only if `fn` is still the current registration — remount-safe
 * (an incoming pane may have registered before the outgoing one destroys). */
export function unregisterBufferFlush(fn: () => void): void {
  if (flush === fn) flush = null
}

/**
 * Synchronously land any pending (debounced) editor→doc serialization into
 * the doc store. Call immediately before reading `doc.content` / isDirty for
 * a decision or a write. No-op when no editor is mounted. Cost: at most one
 * O(doc) serialization — the callers (save/export/guard/stash) are already
 * O(doc) operations.
 */
export function flushBufferEdits(): void {
  if (flush === null || flushing) return
  flushing = true
  try {
    flush()
  } finally {
    flushing = false
  }
}
