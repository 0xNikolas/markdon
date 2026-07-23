import { invoke } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc } from './doc'
import { settings, type Settings } from './settings'
import { reportError, reportFailure } from './errors'
import { flushBufferEdits } from './bufferFlush'
import { basename, splitExt } from './paths'

/**
 * Export flow: writes the current document as standalone HTML or raw
 * Markdown per settings.exportFormat, via the existing save_file_dialog +
 * write_file pipeline. Reached from the header Export button (ui.ts's
 * exportTick), the File menu item, and its accelerator -- all three funnel
 * into exportDocument() (App.svelte).
 *
 * The 'pdf' format is the exception: there is no honest silent direct-to-file
 * PDF API on macOS (wry surfaces only the native print panel), so PDF reuses
 * the SAME clean HTML the html export produces and hands it to the Rust
 * `export_pdf` command, which prints it through the macOS "Save as PDF"
 * dialog. That OS dialog owns file naming/location, so the pdf path calls
 * neither save_file_dialog nor write_file.
 *
 * This module imports Settings['exportFormat'] rather than defining a
 * parallel type, since settings.ts already owns exportFormat as the
 * canonical literal union under key 'markdon.settings.v1'. It never calls
 * loadSettings/parseSettings itself -- settings.ts is already initialized
 * once via main.ts's initSettings().
 */
export type ExportFormat = Settings['exportFormat']

/**
 * Swap the extension for the export format, preserving the source directory
 * so the save dialog opens beside the source file. No path -> untitled.<ext>.
 * Only the last dot-segment is treated as an extension; a leading-dot name
 * (dotfile, e.g. '.notes') has none.
 */
export function deriveExportFilename(path: string | null, format: ExportFormat): string {
  const ext = format === 'html' ? 'html' : format === 'pdf' ? 'pdf' : 'md'
  if (path === null) return `untitled.${ext}`
  const cut = path.lastIndexOf('/') + 1
  const dir = path.slice(0, cut)
  const { stem } = splitExt(path.slice(cut))
  return `${dir}${stem}.${ext}`
}

/**
 * Whether the OS owns the save step for this format. PDF routes through the
 * macOS print dialog ("Save as PDF"), which handles file naming/location, so
 * the app shows no save_file_dialog and writes no file; html/md use the
 * save_file_dialog + write_file pipeline.
 */
export function exportUsesSystemDialog(format: ExportFormat): boolean {
  return format === 'pdf'
}

/** Filename stem used as the exported <title>; 'Untitled' with no path. */
export function docTitle(path: string | null): string {
  if (path === null) return 'Untitled'
  return splitExt(basename(path)).stem
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
 * woff2 is deliberately not embedded, to keep exported files small.
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
 * export works in both. Module-level singleton slot.
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
 * incoming view only registers after its async crepe.create() resolves --
 * Editor.svelte and PreviewPane.svelte each own an independent Crepe
 * instance and register into this shared slot on their own schedule. An
 * export invoked in that window would otherwise see
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
  // The markdown path exports doc.content byte-for-byte, which may trail the
  // editor by one debounce window — land pending edits first. (The HTML/PDF
  // paths serialize from the live editor view and were never stale.)
  flushBufferEdits()
  const state = get(doc)
  const format = get(settings).exportFormat

  try {
    let contents: string
    if (format === 'html' || format === 'pdf') {
      const source = htmlSource ?? (await waitForHtmlSource())
      if (source === null) {
        reportError('Export failed: editor is not ready')
        return
      }
      contents = buildExportHtml(docTitle(state.path), source())
    } else {
      contents = state.content // markdown path: buffer as-is, byte-for-byte
    }

    if (format === 'pdf') {
      // The native macOS print panel ("Save as PDF") owns saving; no
      // save_file_dialog or write_file here. Rust opens a short-lived helper
      // window on the same HTML and, once it renders, presents the panel via
      // NSPrintOperation (see pdf.rs). We pass docTitle as `title`: Rust sets
      // both the print job title and the helper window title from it, so the
      // "Save as PDF" sheet defaults to `<docTitle>.pdf` (the HTML <title>
      // baked in by buildExportHtml carries the same value as a backstop).
      await invoke('export_pdf', { html: contents, title: docTitle(state.path) })
      return
    }

    const selected = await invoke<string | null>('save_file_dialog', {
      defaultPath: deriveExportFilename(state.path, format),
      filters: [exportFilter(format)],
    })
    if (selected === null) return // cancelled
    await invoke('write_file', { path: selected, contents })
  } catch (e) {
    reportFailure('export', e)
  }
}
