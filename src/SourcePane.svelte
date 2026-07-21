<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { EditorState } from '@codemirror/state'
  import { EditorView } from '@codemirror/view'
  import { closeBrackets } from '@codemirror/autocomplete'
  import {
    sourceExtensions,
    tabExt,
    readonlyExt,
    registerSourceView,
    wrapC,
    tabC,
    bracketsC,
    readonlyC,
  } from './lib/sourceEditor'
  import { settings } from './lib/settings'
  import { cursor } from './lib/ui'
  import './cm-theme.css'

  interface Props {
    initialContent: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, readonly = false, onChange }: Props = $props()

  let el: HTMLDivElement
  let view: EditorView | undefined

  onMount(() => {
    const state = EditorState.create({
      doc: initialContent,
      extensions: sourceExtensions(get(settings), readonly, onChange, (c) => cursor.set(c)),
    })
    view = new EditorView({ state, parent: el })
    registerSourceView(view)
    cursor.set({ line: 1, col: 0 }) // seed the status bar for the caret at doc start
  })

  // Reconfigure behavior compartments live when settings change (no rebuild).
  $effect(() => {
    const s = $settings
    view?.dispatch({
      effects: [
        wrapC.reconfigure(s.softWrap ? EditorView.lineWrapping : []),
        tabC.reconfigure(tabExt(s.tabWidth)),
        bracketsC.reconfigure(s.autoCloseBrackets ? closeBrackets() : []),
      ],
    })
  })

  // Reflect the readonly flag (Enable editing lifts it) without a remount.
  $effect(() => {
    view?.dispatch({ effects: readonlyC.reconfigure(readonlyExt(readonly)) })
  })

  onDestroy(() => {
    registerSourceView(null)
    cursor.set(null) // hide the status-bar Ln/Col segment in WYSIWYG mode
    view?.destroy()
  })
</script>

<div class="source" bind:this={el}></div>

<style>
  .source {
    height: 100%;
    overflow: auto;
    background: var(--bg);
  }
</style>
