<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import SourcePane from './SourcePane.svelte'
  import PreviewPane from './PreviewPane.svelte'
  import { createScrollSync } from './lib/scrollSync'

  interface Props {
    /** Seed for the CodeMirror source pane (read once at mount). */
    initialContent: string
    /** Live doc content driving the read-only preview. */
    content: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, content, readonly = false, onChange }: Props = $props()

  // Scroll-sync refs: source's CodeMirror view (for its .scrollDOM scroller)
  // and the preview's scroll container. One-way source->preview sync starts
  // once both are available and tears down when either pane unmounts.
  let sourceView = $state<EditorView>()
  let previewEl = $state<HTMLElement>()

  $effect(() => {
    if (!sourceView || !previewEl) return
    return createScrollSync(sourceView.scrollDOM, previewEl)
  })
</script>

<div class="split">
  <div class="pane source">
    <SourcePane {initialContent} {readonly} {onChange} onViewReady={(v) => (sourceView = v)} />
  </div>
  <div class="pane preview">
    <PreviewPane {content} bind:scrollEl={previewEl} />
  </div>
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .pane.preview {
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
</style>
