<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import { replaceAll, getHTML } from '@milkdown/kit/utils'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // after the Crepe theme, to override its fonts
  import { registerHtmlSource, unregisterHtmlSource } from './lib/export'

  interface Props {
    content: string
  }
  let { content }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined
  let ready: Promise<unknown> | undefined
  // Init to the mount-time content: that value is the defaultValue, already
  // rendered, so the first $effect run is a no-op instead of a redundant push.
  // untrack captures the initial value without making this a reactive read.
  let lastPushed = untrack(() => content)
  let timer: ReturnType<typeof setTimeout> | undefined
  // Export's HTML source while split mode is mounted -- registered once this
  // pane's Crepe instance exists so export works in split mode too
  // (amendments.md #5: Editor.svelte AND PreviewPane share the slot).
  let source: (() => string) | undefined
  // Set in onDestroy; checked after `ready` resolves so a pane unmounted
  // mid-create (fast split-mode toggle) never registers a closure over an
  // already-destroyed Crepe instance -- see Editor.svelte's matching guard.
  let destroyed = false

  onMount(() => {
    crepe = new Crepe({
      root: el,
      defaultValue: content,
      // A pane you can't edit needs no drag handles / toolbar / placeholder /
      // block cursor. LinkTooltip/ListItem stay (harmless read affordances).
      features: {
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.Placeholder]: false,
        [Crepe.Feature.Cursor]: false,
      },
    })
    crepe.setReadonly(true) // flips only the editable prop -> replaceAll still dispatches
    ready = crepe.create() // NO markdownUpdated listener -> no echo back into edit()
    ready.then(() => {
      if (destroyed) return // unmounted while create() was in flight -- don't register
      // Export needs doc.content verbatim, but this pane only reflects it
      // after the 150ms debounce below settles, so a getHTML() call right
      // after typing could otherwise serialize a stale preview. Flush any
      // pending push synchronously first: `flushPendingUpdate` reads the
      // `content` prop directly (a rune, so this always reads its current
      // value, never a stale closure) and applies replaceAll immediately.
      // replaceAll's non-flush path dispatches synchronously to the
      // ProseMirror view (see the $effect below), so by the time
      // flushPendingUpdate returns the DOM already matches doc.content,
      // and the subsequent getHTML() call serializes that same content.
      source = () => {
        flushPendingUpdate()
        return crepe!.editor.action(getHTML())
      }
      registerHtmlSource(source)
    })
  })

  // Live sync: debounce bursts, then replace the whole preview doc. replaceAll's
  // non-flush path is a plain view.dispatch, which works on a readonly editor.
  $effect(() => {
    const md = content // track
    if (md === lastPushed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      lastPushed = md
      void ready?.then(() => crepe?.editor.action(replaceAll(md)))
    }, 150)
  })

  // Cancels a pending debounced push (if any) and applies it to the Crepe
  // doc immediately, synchronously, using the latest `content` prop. See
  // the call site above for why this makes exported HTML always reflect
  // doc.content at invocation time regardless of the 150ms debounce.
  function flushPendingUpdate(): void {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    lastPushed = content
    crepe?.editor.action(replaceAll(content))
  }

  onDestroy(() => {
    destroyed = true
    clearTimeout(timer)
    if (source) unregisterHtmlSource(source)
    void crepe?.destroy()
  })
</script>

<div class="preview" bind:this={el}></div>

<style>
  .preview {
    height: 100%;
    overflow: auto;
    background: var(--bg);
  }
</style>
