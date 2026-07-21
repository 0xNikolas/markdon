import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { doc, newDoc, openDoc } from './doc'
import { settings, DEFAULTS } from './settings'
import { errorMessage } from './errors'
import {
  deriveExportFilename,
  docTitle,
  escapeHtml,
  buildExportHtml,
  registerHtmlSource,
  unregisterHtmlSource,
  exportDocument,
} from './export'

describe('deriveExportFilename', () => {
  it('defaults to untitled.<ext> when there is no path', () => {
    expect(deriveExportFilename(null, 'html')).toBe('untitled.html')
    expect(deriveExportFilename(null, 'md')).toBe('untitled.md')
  })

  it('swaps the extension, preserving the source directory', () => {
    expect(deriveExportFilename('/a/b/notes.md', 'html')).toBe('/a/b/notes.html')
  })

  it('swaps only the last dot-segment on a multi-dot name', () => {
    expect(deriveExportFilename('/a/b/notes.v2.md', 'html')).toBe('/a/b/notes.v2.html')
  })

  it('appends the extension when the source has none', () => {
    expect(deriveExportFilename('/a/README', 'html')).toBe('/a/README.html')
  })

  it('treats a leading-dot filename as having no extension', () => {
    expect(deriveExportFilename('/a/.notes', 'html')).toBe('/a/.notes.html')
  })

  it('is identity for a markdown export of a .md path', () => {
    expect(deriveExportFilename('/a/b/notes.md', 'md')).toBe('/a/b/notes.md')
  })
})

describe('docTitle', () => {
  it('is the filename stem', () => {
    expect(docTitle('/a/b/notes.md')).toBe('notes')
  })
  it('is Untitled with no path', () => {
    expect(docTitle(null)).toBe('Untitled')
  })
})

describe('escapeHtml', () => {
  it('escapes all five entities', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })
})

describe('buildExportHtml', () => {
  it('starts with the doctype', () => {
    expect(buildExportHtml('t', '<p></p>')).toMatch(/^<!doctype html>/)
  })

  it('escapes the title', () => {
    expect(buildExportHtml('<b>&', '<p></p>')).toContain('<title>&lt;b&gt;&amp;</title>')
  })

  it('includes bodyHtml verbatim, unescaped', () => {
    expect(buildExportHtml('t', '<p>&amp;</p>')).toContain('<p>&amp;</p>')
  })

  it('carries the Figma light tokens and font family', () => {
    const html = buildExportHtml('t', '<p></p>')
    expect(html).toContain('#f8fafc')
    expect(html).toContain('#e5682b')
    expect(html).toContain('Geist')
  })
})

describe('exportDocument orchestration', () => {
  beforeEach(() => {
    invoke.mockReset()
    newDoc()
    settings.set({ ...DEFAULTS })
    errorMessage.set(null)
    unregisterHtmlSourceIfAny()
  })

  // htmlSource is module-private; tests only touch it via register/unregister.
  function unregisterHtmlSourceIfAny() {
    const noop = () => ''
    registerHtmlSource(noop)
    unregisterHtmlSource(noop)
  }

  it('html format: save_file_dialog gets the .html filter, write_file gets the wrapped template', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'html' })
    const source = () => '<h1>Hi</h1>'
    registerHtmlSource(source)
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/a/b/notes.html' : undefined,
    )

    await exportDocument()

    expect(invoke).toHaveBeenCalledWith('save_file_dialog', {
      defaultPath: '/a/b/notes.html',
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    expect(invoke).toHaveBeenCalledWith('write_file', {
      path: '/a/b/notes.html',
      contents: expect.stringContaining('<h1>Hi</h1>'),
    })
    unregisterHtmlSource(source)
  })

  it('markdown format: contents is doc.content verbatim, filter is Markdown', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'md' })
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/a/b/notes.md' : undefined,
    )

    await exportDocument()

    expect(invoke).toHaveBeenCalledWith('save_file_dialog', {
      defaultPath: '/a/b/notes.md',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/a/b/notes.md', contents: '# Hi' })
  })

  it('does nothing when the dialog is cancelled', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'md' })
    invoke.mockResolvedValue(null)

    await exportDocument()

    expect(invoke).toHaveBeenCalledTimes(1) // only the dialog, no write_file
  })

  it('html format with no registered source reports an error and never invokes', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'html' })

    await exportDocument()

    expect(get(errorMessage)).toContain('Export failed')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not touch doc.savedContent/path -- export is not save', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'md' })
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/somewhere/else.md' : undefined,
    )

    const before = get(doc)
    await exportDocument()
    const after = get(doc)

    expect(after.path).toBe(before.path)
    expect(after.savedContent).toBe(before.savedContent)
  })

  it('unregisterHtmlSource is a no-op unless it is the currently registered fn (remount-safe)', async () => {
    openDoc('/a/b/notes.md', '# Hi')
    settings.set({ ...DEFAULTS, exportFormat: 'html' })
    const stale = () => 'stale'
    const current = () => '<p>current</p>'
    registerHtmlSource(stale)
    registerHtmlSource(current)
    unregisterHtmlSource(stale) // must not clear `current`

    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === 'save_file_dialog' ? '/a/b/notes.html' : undefined,
    )
    await exportDocument()

    expect(invoke).toHaveBeenCalledWith(
      'write_file',
      expect.objectContaining({ contents: expect.stringContaining('current') }),
    )
    unregisterHtmlSource(current)
  })
})
