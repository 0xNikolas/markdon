<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'

  interface Props {
    initialContent: string
    onChange: (markdown: string) => void
  }
  let { initialContent, onChange }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined

  onMount(async () => {
    crepe = new Crepe({ root: el, defaultValue: initialContent })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown))
    })
    await crepe.create()
  })

  onDestroy(() => crepe?.destroy())
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor { height: 100%; overflow: auto; }
</style>
