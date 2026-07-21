import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc } from './doc'
import { settings, type Settings } from './settings'
import { reportError } from './errors'

/**
 * Export flow: writes the current document as standalone HTML or raw
 * Markdown per settings.exportFormat, via the existing save_file_dialog +
 * write_file pipeline. Reached from the header Export button (ui.ts's
 * exportTick), the File menu item, and its accelerator -- all three funnel
 * into exportDocument() (App.svelte).
 *
 * Deviation from spec-export.json: this repo's settings.ts (landed by the
 * settings feature) already owns exportFormat as the literal union
 * 'html' | 'md' under key 'markdon.settings.v1', not this spec's own
 * 'html' | 'markdown' / 'markdon.settings' proposal -- reality wins per the
 * amendments; this module imports Settings['exportFormat'] rather than
 * defining a parallel type, and never calls loadSettings/parseSettings
 * itself (settings.ts is already initialized once via main.ts's
 * initSettings()).
 */
export type ExportFormat = Settings['exportFormat']

/**
 * Swap the extension for the export format, preserving the source directory
 * so the save dialog opens beside the source file. No path -> untitled.<ext>.
 * Only the last dot-segment is treated as an extension; a leading-dot name
 * (dotfile, e.g. '.notes') has none.
 */
export function deriveExportFilename(path: string | null, format: ExportFormat): string {
  const ext = format === 'html' ? 'html' : 'md'
  if (path === null) return `untitled.${ext}`
  const cut = path.lastIndexOf('/') + 1
  const dir = path.slice(0, cut)
  const name = path.slice(cut)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${dir}${stem}.${ext}`
}

/** Filename stem used as the exported <title>; 'Untitled' with no path. */
export function docTitle(path: string | null): string {
  if (path === null) return 'Untitled'
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/**
 * Wrap a serialized ProseMirror-HTML fragment into a standalone document
 * styled with the Figma-authoritative LIGHT tokens (the export is a static
 * artifact, not theme-aware) and the app's font stacks by name -- Geist
 * woff2 is deliberately not embedded (keeps exports small; documented
 * rejected alternative in spec-export.json).
 */
export function buildExportHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; background: #f8fafc; color: #1e293b;
  font: 15px/1.6 "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 48px 32px; }
h1, h2, h3, h4, h5, h6 { color: #0f1729; }
h1 { font-size: 28px; font-weight: 700; }
h2 { font-size: 20px; font-weight: 600; }
a { color: #e5682b; }
code { font: 13px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #e2e8f0; border-radius: 4px; padding: 1px 4px; }
pre { background: #e2e8f0; border-radius: 8px; padding: 16px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 0; padding: 12px 16px; background: #e2e8f0;
  border-left: 3px solid #e5682b; border-radius: 4px; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body><main>
${bodyHtml}
</main></body>
</html>
`
}

/**
 * Bridge: the live editor whose Crepe instance can serialize the current
 * doc to HTML. Editor.svelte (WYSIWYG) and PreviewPane.svelte (split mode's
 * rendered pane) each register/unregister their own provider here after
 * `crepe.create()` -- whichever view mode is mounted supplies the source, so
 * export works in both (amendments.md #5). Module-level singleton slot,
 * same pattern as spec-search's EditorView registration.
 */
let htmlSource: (() => string) | null = null

export function registerHtmlSource(fn: () => string): void {
  htmlSource = fn
}

/** Unregisters only if `fn` is still the current registration -- remount-safe. */
export function unregisterHtmlSource(fn: () => string): void {
  if (htmlSource === fn) htmlSource = null
}

function exportFilter(format: ExportFormat): { name: string; extensions: string[] } {
  return format === 'html'
    ? { name: 'HTML', extensions: ['html'] }
    : { name: 'Markdown', extensions: ['md', 'markdown'] }
}

const SOURCE_RETRY_ATTEMPTS = 10
const SOURCE_RETRY_DELAY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bridge the registration gap during a split-mode toggle: the outgoing
 * view's htmlSource is unregistered synchronously (onDestroy), but the
 * incoming view only registers after its async crepe.create() resolves
 * (amendments.md #5's shared-slot mechanism, split across Editor.svelte and
 * PreviewPane.svelte). An export invoked in that window would otherwise see
 * `htmlSource === null` for a doc that is, from the user's perspective,
 * still open. Poll briefly instead of failing immediately; bounded so a
 * genuinely broken registration still surfaces reportError rather than
 * hanging.
 */
async function waitForHtmlSource(): Promise<(() => string) | null> {
  for (let attempt = 0; attempt < SOURCE_RETRY_ATTEMPTS && htmlSource === null; attempt++) {
    await delay(SOURCE_RETRY_DELAY_MS)
  }
  return htmlSource
}

/**
 * Export the current document per settings.exportFormat. Not guarded by the
 * dirty-modal (snapshots the current buffer; nothing is lost) and never
 * calls markSaved or mutates doc -- exporting is not saving.
 *
 * The entire fallible section -- resolving the HTML source, building the
 * template, showing the save dialog, and writing the file -- runs inside
 * one try/catch so a throwing htmlSource() (e.g. a stale closure over a
 * destroyed Crepe instance) reaches reportError instead of becoming an
 * unhandled promise rejection.
 */
export async function exportDocument(): Promise<void> {
  const state = get(doc)
  const format = get(settings).exportFormat

  try {
    let contents: string
    if (format === 'html') {
      const source = htmlSource ?? (await waitForHtmlSource())
      if (source === null) {
        reportError('Export failed: editor is not ready')
        return
      }
      contents = buildExportHtml(docTitle(state.path), source())
    } else {
      contents = state.content // markdown path: buffer as-is, byte-for-byte
    }

    const selected = await invoke<string | null>('save_file_dialog', {
      defaultPath: deriveExportFilename(state.path, format),
      filters: [exportFilter(format)],
    })
    if (selected === null) return // cancelled
    await invoke('write_file', { path: selected, contents })
  } catch (e) {
    reportError(`Could not export: ${String(e)}`)
  }
}
