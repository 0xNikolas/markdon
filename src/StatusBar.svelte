<script lang="ts">
  interface Props {
    path: string | null
    dirty: boolean
    content: string
  }
  let { path, dirty, content }: Props = $props()

  const filename = $derived(path ? path.split('/').pop() : 'Untitled')
  const words = $derived(content.trim() ? content.trim().split(/\s+/).length : 0)
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
