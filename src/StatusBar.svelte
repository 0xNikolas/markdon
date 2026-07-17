<script lang="ts">
  interface Props {
    path: string | null
    dirty: boolean
    content: string
  }
  let { path, dirty, content }: Props = $props()

  const filename = $derived(path ? path.split('/').pop() : 'Untitled')
  // Count runs of letters/digits (keeping apostrophes/hyphens inside words) so
  // markdown syntax tokens like `#`, `*`, `>` aren't counted as words.
  const words = $derived(
    (content.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length,
  )
</script>

<footer class="status">
  <span class="name">{filename}{dirty ? ' •' : ''}</span>
  <span class="words">{words} words</span>
</footer>

<style>
  .status {
    display: flex;
    justify-content: space-between;
    padding: 4px 12px;
    font: 12px system-ui, sans-serif;
    border-top: 1px solid #ddd;
    background: #f7f7f7;
  }
</style>
