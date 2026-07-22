<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import { replaceAll } from '@milkdown/kit/utils'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // after the Crepe theme, to override its fonts
  import { get } from 'svelte/store'
  import { doc } from './lib/doc'
  import { resolveImageSrc } from './lib/imagePaste'

  // Minimal read-only Crepe render, factored from PreviewPane.svelte but WITHOUT
  // its registerHtmlSource/export wiring: this is a File History version preview,
  // and hijacking export's HTML source (PreviewPane's job) would clobber the real
  // document's export. Deliberately imports no export module.
  interface Props {
    content: string
  }
  let { content }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined
  let ready: Promise<unknown> | undefined
  // Init to mount-time content (already the defaultValue), so the first $effect
  // run is a no-op rather than a redundant replaceAll.
  let lastPushed = untrack(() => content)
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
      featureConfigs: {
        // History versions belong to the open document, so relative pasted-
        // image links resolve against the same doc path as the live editor.
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: (url: string) => resolveImageSrc(url, get(doc).path),
        },
      },
    })
    crepe.setReadonly(true) // flips only the editable prop -> replaceAll still dispatches
    ready = crepe.create() // NO markdownUpdated listener -> nothing echoes out
  })

  // Selecting a different version updates `content`; push it into the doc.
  // replaceAll's non-flush path is a plain view.dispatch, which works readonly.
  $effect(() => {
    const md = content // track
    if (md === lastPushed) return
    lastPushed = md
    void ready?.then(() => {
      if (!destroyed) crepe?.editor.action(replaceAll(md))
    })
  })

  onDestroy(() => {
    destroyed = true
    void crepe?.destroy()
  })
</script>

<div class="readonly-markdown" bind:this={el}></div>

<style>
  .readonly-markdown {
    height: 100%;
    overflow: auto;
    background: var(--bg);
  }
</style>
