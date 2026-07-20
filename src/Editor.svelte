<script module lang="ts">
  import frameDark from '@milkdown/crepe/theme/frame-dark.css?inline'
  import { scopeDarkCss } from './lib/theme'

  // Runs once (module scope), before any instance mounts. Guarded against
  // double-append on HMR.
  if (!document.head.querySelector('style[data-crepe-dark]')) {
    const el = document.createElement('style')
    el.setAttribute('data-crepe-dark', '')
    el.textContent = scopeDarkCss(frameDark)
    document.head.append(el)
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // must come after the Crepe theme to override its fonts

  interface Props {
    initialContent: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, readonly = false, onChange }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined

  onMount(async () => {
    crepe = new Crepe({ root: el, defaultValue: initialContent })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown))
    })
    crepe.setReadonly(readonly)
    await crepe.create()
  })

  // Toggle in place (no remount) when Enable editing lifts the flag.
  $effect(() => {
    crepe?.setReadonly(readonly)
  })

  onDestroy(() => crepe?.destroy())
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor { height: 100%; overflow: auto; }
</style>
