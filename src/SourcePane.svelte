<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { EditorSelection, EditorState } from '@codemirror/state'
  import { EditorView } from '@codemirror/view'
  import { closeBrackets } from '@codemirror/autocomplete'
  import {
    sourceExtensions,
    createDocSync,
    tabExt,
    readonlyExt,
    registerSourceView,
    wrapC,
    tabC,
    bracketsC,
    readonlyC,
  } from './lib/sourceEditor'
  import { registerBufferFlush, unregisterBufferFlush } from './lib/bufferFlush'
  import {
    registerViewStateProvider,
    unregisterViewStateProvider,
    consumePendingViewState,
    type ViewState,
  } from './lib/bufferCache'
  import { settings } from './lib/settings'
  import { cursor } from './lib/ui'
  import './cm-theme.css'

  interface Props {
    initialContent: string
    readonly?: boolean
    onChange: (markdown: string) => void
    /** Notified with the EditorView once created, for SplitView's scroll sync. */
    onViewReady?: (view: EditorView) => void
  }
  let { initialContent, readonly = false, onChange, onViewReady }: Props = $props()

  let el: HTMLDivElement
  let view: EditorView | undefined
  // Cursor/scroll snapshot provider for the buffer cache (stash-on-switch).
  let viewStateProvider: (() => ViewState) | undefined

  // Doc→store sync: synchronous for ordinary docs, trailing-debounced above
  // sourceEditor's DOC_SYNC_LIMIT so huge docs don't pay an O(doc) toString
  // per keystroke. Its flush registers with bufferFlush so every read point
  // (save/export/guard/stash) lands pending edits first. The closure reads
  // the live `onChange` prop at emit time (not the mount-time value).
  const docSync = createDocSync((md) => onChange(md))

  onMount(() => {
    const state = EditorState.create({
      doc: initialContent,
      extensions: sourceExtensions(get(settings), readonly, docSync, (c) => cursor.set(c)),
    })
    view = new EditorView({ state, parent: el })
    registerSourceView(view)
    registerBufferFlush(docSync.flush)
    onViewReady?.(view)
    cursor.set({ line: 1, col: 0 }) // seed the status bar for the caret at doc start
    viewStateProvider = () => ({
      mode: 'source',
      cursor: view!.state.selection.main.head,
      scroll: view!.scrollDOM.scrollTop,
    })
    registerViewStateProvider(viewStateProvider)
    // Restore a pending buffer-cache view state, if a cache-hit open parked
    // one for this mode. Best-effort: clamped to the doc, never throws out.
    const vs = consumePendingViewState('source')
    if (vs !== null) {
      try {
        const pos = Math.max(0, Math.min(vs.cursor, view.state.doc.length))
        view.dispatch({ selection: EditorSelection.cursor(pos) })
        view.scrollDOM.scrollTop = vs.scroll
      } catch {
        /* view-state restore is cosmetic; the buffer itself is already live */
      }
    }
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
    unregisterBufferFlush(docSync.flush)
    // Cancel, don't flush: every doc-replacing flow (openPath's stash, the
    // guards, the split toggle's pre-effect in App) has already flushed
    // through bufferFlush before this unmount, so anything still pending here
    // could only serialize the OLD text into whatever doc is live next.
    docSync.cancel()
    if (viewStateProvider) unregisterViewStateProvider(viewStateProvider)
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
