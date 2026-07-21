<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import { replaceAll } from '@milkdown/kit/utils'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // after the Crepe theme, to override its fonts

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
  })

  // Live sync: debounce bursts, then replace the whole preview doc. replaceAll's
  // non-flush path is a plain view.dispatch, which works on a readonly editor.
  $effect(() => {
    const md = content // track
    if (md === lastPushed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      lastPushed = md
      void ready?.then(() => crepe?.editor.action(replaceAll(md)))
    }, 150)
  })

  onDestroy(() => {
    clearTimeout(timer)
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
