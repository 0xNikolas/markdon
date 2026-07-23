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
  import { commandsCtx, editorViewCtx, schemaCtx } from '@milkdown/kit/core'
  import { TextSelection } from '@milkdown/kit/prose/state'
  import { getHTML } from '@milkdown/kit/utils'
  import { uploadConfig } from '@milkdown/kit/plugin/upload'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'
  import './editor-theme.css' // must come after the Crepe theme to override its fonts
  import { get } from 'svelte/store'
  import { searchPlugin } from './lib/searchPlugin'
  import { registerHtmlSource, unregisterHtmlSource } from './lib/export'
  import { registerBufferFlush, unregisterBufferFlush } from './lib/bufferFlush'
  import { doc } from './lib/doc'
  import {
    registerViewStateProvider,
    unregisterViewStateProvider,
    consumePendingViewState,
    type ViewState,
  } from './lib/bufferCache'
  import { uploadPastedImage, resolveImageSrc } from './lib/imagePaste'
  import { checkEditorSchema } from './lib/schemaCheck'
  import boldIcon from './assets/icons/bold.svg?raw'
  import italicIcon from './assets/icons/italic.svg?raw'
  import linkIcon from './assets/icons/link-2.svg?raw'

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
  // Cursor/scroll snapshot provider for the buffer cache (stash-on-switch);
  // registered post-create like `source` since it reads editorViewCtx.
  let viewStateProvider: (() => ViewState) | undefined
  // Buffer-flush hook (bufferFlush.ts): Crepe's hardwired listener plugin
  // serializes on a 200ms trailing debounce, so doc.content can miss the
  // newest keystrokes; save/export/guard/stash call flushBufferEdits() and
  // this closure lands the current editor text through the SAME onChange
  // path (onEditorChange), keeping adoptNormalization semantics intact.
  let bufferFlush: (() => void) | undefined

  onMount(async () => {
    crepe = new Crepe({
      root: el,
      defaultValue: initialContent,
      featureConfigs: {
        [Crepe.Feature.Toolbar]: { boldIcon, italicIcon, linkIcon },
        [Crepe.Feature.ImageBlock]: {
          // Paste/upload writes a real `<stem>-pasted-<n>.<ext>` file next to
          // a saved doc and links it by bare relative name -- Crepe's default
          // (a multi-MB data: URI on one line) is what froze Split Preview.
          onUpload: uploadPastedImage,
          // Render-time mapping of that relative name back to an asset:
          // URL. Reads the live doc path per call (not mount-time): a
          // Save As while this editor is mounted moves the doc, and the
          // images must resolve against wherever it lives NOW.
          proxyDomURL: (url: string) => resolveImageSrc(url, get(doc).path),
        },
      },
    })
    crepe.editor.use(searchPlugin) // before create(): the editor exists pre-create (CrepeBuilder ctor)
    crepe.editor.config((ctx) => {
      // Replace Crepe's built-in paste uploader outright. Its version resolves
      // the target node type through the crepe-features ctx, which comes up
      // empty in production bundles -- pasted images were then dropped with no
      // insert, no error (dev builds worked, release silently swallowed).
      // Resolving straight from the schema avoids that machinery entirely,
      // and routes the file through the same save-to-disk upload as onUpload.
      ctx.update(uploadConfig.key, (prev) => ({
        ...prev,
        uploader: async (files, schema) => {
          const imgs: File[] = []
          for (let i = 0; i < files.length; i++) {
            const f = files.item(i)
            if (f && f.type.includes('image')) imgs.push(f)
          }
          const nodeType = schema.nodes['image-block'] ?? schema.nodes.image
          if (!nodeType || imgs.length === 0) return []
          const nodes = await Promise.all(
            imgs.map(async (f) => nodeType.createAndFill({ src: await uploadPastedImage(f) })),
          )
          return nodes.filter((n) => n !== null && n !== undefined)
        },
      }))
    })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown))
    })
    crepe.setReadonly(readonly)
    await crepe.create()
    if (destroyed) return // unmounted while create() was in flight -- don't register
    // Dev/release parity self-check: fail loudly at mount if the built
    // schema lost a node/mark type or command the app depends on (the
    // uploader above already works around one such prod-only regression).
    // Safe to read here: create() resolved, so CommandsReady is done.
    checkEditorSchema(() => {
      const ctx = crepe!.editor.ctx
      const commands = ctx.get(commandsCtx)
      return { schema: ctx.get(schemaCtx), getCommand: (name: string) => commands.get(name) }
    })
    source = () => crepe!.editor.action(getHTML())
    registerHtmlSource(source)
    bufferFlush = () => onChange(crepe!.getMarkdown())
    registerBufferFlush(bufferFlush)
    // Buffer-cache view state: capture on demand (stashActive reads the live
    // view at switch time)…
    viewStateProvider = () => {
      const view = crepe!.editor.ctx.get(editorViewCtx)
      return { mode: 'wysiwyg', cursor: view.state.selection.head, scroll: el.scrollTop }
    }
    registerViewStateProvider(viewStateProvider)
    // …and restore the pending hand-off, if a cache-hit open parked one for
    // this mode. Best-effort: clamped, and a throw must never break the open.
    const vs = consumePendingViewState('wysiwyg')
    if (vs !== null) {
      try {
        const view = crepe.editor.ctx.get(editorViewCtx)
        const pos = Math.max(0, Math.min(vs.cursor, view.state.doc.content.size))
        view.dispatch(
          view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))),
        )
        el.scrollTop = vs.scroll
      } catch {
        /* view-state restore is cosmetic; the buffer itself is already live */
      }
    }
  })

  // Toggle in place (no remount) when Enable editing lifts the flag.
  $effect(() => {
    crepe?.setReadonly(readonly)
  })

  onDestroy(() => {
    destroyed = true
    if (source) unregisterHtmlSource(source)
    if (bufferFlush) unregisterBufferFlush(bufferFlush)
    if (viewStateProvider) unregisterViewStateProvider(viewStateProvider)
    crepe?.destroy()
  })
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor { height: 100%; overflow: auto; }
</style>
