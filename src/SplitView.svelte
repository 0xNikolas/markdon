<script lang="ts">
  import SourcePane from './SourcePane.svelte'
  import PreviewPane from './PreviewPane.svelte'

  interface Props {
    /** Seed for the CodeMirror source pane (read once at mount). */
    initialContent: string
    /** Live doc content driving the read-only preview. */
    content: string
    readonly?: boolean
    onChange: (markdown: string) => void
  }
  let { initialContent, content, readonly = false, onChange }: Props = $props()
</script>

<div class="split">
  <div class="pane source">
    <SourcePane {initialContent} {readonly} {onChange} />
  </div>
  <div class="pane preview">
    <PreviewPane {content} />
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
