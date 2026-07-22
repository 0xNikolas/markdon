<script lang="ts">
  import type { EditorView } from '@codemirror/view'
  import SourcePane from './SourcePane.svelte'
  import PreviewPane from './PreviewPane.svelte'
  import { createScrollSync } from './lib/scrollSync'
  import { LONG_LINE_LIMIT, maxLineLength } from './lib/sourceEditor'

  interface Props {
    /** Seed for the CodeMirror source pane (read once at mount). */
    initialContent: string
    /** Live doc content driving the read-only preview. */
    content: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, content, readonly = false, onChange }: Props = $props()

  // Freeze guard: mounting CodeMirror on a doc with a multi-MB single line
  // (an inlined data: URI image) hangs WebKit's line layout indefinitely --
  // see LONG_LINE_LIMIT's rationale. Evaluated once at mount, which is sound:
  // while split is open the WYSIWYG editor is unmounted and the source pane
  // -- the only other editor -- is exactly the pane suppressed here, so the
  // content cannot grow a huge line while this component is alive.
  // svelte-ignore state_referenced_locally -- initialContent is read-once by
  // contract (see Props); the mount-time snapshot is the point.
  const hugeLine = maxLineLength(initialContent) > LONG_LINE_LIMIT

  // Scroll-sync refs: source's CodeMirror view (for its .scrollDOM scroller)
  // and the preview's scroll container. One-way source->preview sync starts
  // once both are available and tears down when either pane unmounts. When
  // the hugeLine fallback replaces SourcePane, sourceView is never set and
  // this effect stays a permanent no-op.
  let sourceView = $state<EditorView>()
  let previewEl = $state<HTMLElement>()

  $effect(() => {
    if (!sourceView || !previewEl) return
    return createScrollSync(sourceView.scrollDOM, previewEl)
  })
</script>

<div class="split">
  <div class="pane source">
    {#if hugeLine}
      <div class="source-fallback">
        <h2>Source view unavailable</h2>
        <p>
          This document contains a line over 100,000 characters (usually an embedded image),
          which the source editor cannot display safely. The preview on the right stays live.
        </p>
      </div>
    {:else}
      <SourcePane {initialContent} {readonly} {onChange} onViewReady={(v) => (sourceView = v)} />
    {/if}
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
  .source-fallback {
    height: 100%;
    padding: 32px 24px;
    background: var(--bg);
    overflow: auto;
  }
  .source-fallback h2 {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-strong);
  }
  .source-fallback p {
    margin: 0;
    max-width: 44ch;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg-muted);
  }
</style>
