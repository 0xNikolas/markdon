<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import { replaceAll, getHTML } from '@milkdown/kit/utils'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // after the Crepe theme, to override its fonts
  import { get } from 'svelte/store'
  import { registerHtmlSource, unregisterHtmlSource } from './lib/export'
  import { doc } from './lib/doc'
  import { resolveImageSrc } from './lib/imagePaste'
  import { createPreviewScheduler } from './lib/previewSchedule'

  interface Props {
    content: string
    /** The pane's scroll container, exposed for SplitView's scroll sync. */
    scrollEl?: HTMLElement
  }
  let { content, scrollEl = $bindable(undefined) }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined
  let ready: Promise<unknown> | undefined
  // Export's HTML source while split mode is mounted -- registered once this
  // pane's Crepe instance exists so export works in split mode too. Editor.svelte
  // and PreviewPane both share the same export slot, one at a time.
  let source: (() => string) | undefined
  // Set in onDestroy; checked after `ready` resolves so a pane unmounted
  // mid-create (fast split-mode toggle) never registers a closure over an
  // already-destroyed Crepe instance -- see Editor.svelte's matching guard.
  let destroyed = false
  // True once crepe.create() has resolved: from then on the scheduler's
  // apply is a synchronous replaceAll dispatch, which the export contract
  // below relies on. Before that, apply chains onto `ready` (best-effort;
  // the export source is only registered after `ready` resolves anyway).
  let created = false

  // Adaptive live sync for the whole-doc re-parse that replaceAll performs:
  // debounce delay scales with document size, and pushes park while the
  // window is hidden (one parse on becoming visible, not one per settle).
  // `initial` is the mount-time content: that value is the defaultValue,
  // already rendered, so the first $effect run is a no-op instead of a
  // redundant push. untrack reads it without creating a reactive dependency.
  const scheduler = createPreviewScheduler({
    initial: untrack(() => content),
    apply: (md) => {
      if (created) crepe!.editor.action(replaceAll(md))
      else void ready?.then(() => crepe?.editor.action(replaceAll(md)))
    },
  })

  onMount(() => {
    // `el` (Crepe's mount root) is the pane's actual overflow:auto scroller
    // -- Crepe's own .milkdown/.ProseMirror CSS sets no height or overflow.
    scrollEl = el
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
      featureConfigs: {
        // Same relative-image resolution as Editor.svelte (no onUpload: a
        // readonly pane never uploads) so pasted `<stem>-pasted-<n>.<ext>`
        // links render in split preview too.
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: (url: string) => resolveImageSrc(url, get(doc).path),
        },
      },
    })
    crepe.setReadonly(true) // flips only the editable prop -> replaceAll still dispatches
    ready = crepe.create() // NO markdownUpdated listener -> no echo back into edit()
    ready.then(() => {
      if (destroyed) return // unmounted while create() was in flight -- don't register
      created = true
      // Export needs doc.content verbatim, but this pane only reflects it
      // after the scheduler's debounce settles, so a getHTML() call right
      // after typing could otherwise serialize a stale preview. Flush any
      // pending push synchronously first: with `created` set (guaranteed
      // here), scheduler.flush() applies replaceAll immediately, and
      // replaceAll's non-flush path dispatches synchronously to the
      // ProseMirror view, so by the time flush returns the DOM already
      // matches doc.content and getHTML() serializes that same content.
      source = () => {
        scheduler.flush()
        return crepe!.editor.action(getHTML())
      }
      registerHtmlSource(source)
    })
  })

  // Live sync: hand every content change to the scheduler, which debounces
  // bursts (delay scaled to doc size) and applies via replaceAll. replaceAll's
  // non-flush path is a plain view.dispatch, which works on a readonly editor.
  $effect(() => {
    scheduler.notify(content)
  })

  onDestroy(() => {
    destroyed = true
    scheduler.dispose()
    if (source) unregisterHtmlSource(source)
    void crepe?.destroy()
    scrollEl = undefined
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
