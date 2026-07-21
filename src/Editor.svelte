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
  import { getHTML } from '@milkdown/kit/utils'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // must come after the Crepe theme to override its fonts
  import { searchPlugin } from './lib/searchPlugin'
  import { registerHtmlSource, unregisterHtmlSource } from './lib/export'

  interface Props {
    initialContent: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, readonly = false, onChange }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined
  // Export's HTML source for this (WYSIWYG) view mode; registered post-create
  // since getHTML() reads editorViewCtx, which only exists after create().
  let source: (() => string) | undefined
  // Set in onDestroy; checked after the `await crepe.create()` below so a
  // view unmounted mid-create (e.g. a fast split-mode toggle) never
  // registers a closure over an already-destroyed Crepe instance -- that
  // stale closure would throw when export later called it.
  let destroyed = false

  onMount(async () => {
    crepe = new Crepe({ root: el, defaultValue: initialContent })
    crepe.editor.use(searchPlugin) // before create(): the editor exists pre-create (CrepeBuilder ctor)
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown))
    })
    crepe.setReadonly(readonly)
    await crepe.create()
    if (destroyed) return // unmounted while create() was in flight -- don't register
    source = () => crepe!.editor.action(getHTML())
    registerHtmlSource(source)
  })

  // Toggle in place (no remount) when Enable editing lifts the flag.
  $effect(() => {
    crepe?.setReadonly(readonly)
  })

  onDestroy(() => {
    destroyed = true
    if (source) unregisterHtmlSource(source)
    crepe?.destroy()
  })
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor { height: 100%; overflow: auto; }
</style>
