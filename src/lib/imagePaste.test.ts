import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { get } from 'svelte/store'
import { invoke, convertFileSrc } from './test-support/tauriMocks'
import { doc, docWith, newDoc } from './doc'
import { errorMessage } from './errors'
import { extFromMime, bytesToBase64, uploadPastedImage, resolveImageSrc } from './imagePaste'

// Deterministic object-URL stub: node's own URL.createObjectURL returns an
// opaque blob:nodedata: UUID; the tests only care that the fallback path
// returns "an object URL of this file".
let createObjectURL: MockInstance<(obj: Blob | MediaSource) => string>

beforeEach(() => {
  invoke.mockReset()
  convertFileSrc.mockClear()
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
  newDoc()
  errorMessage.set(null)
})

afterEach(() => {
  createObjectURL.mockRestore()
})

describe('extFromMime', () => {
  it('maps the four supported image mimes to backend-allowlisted extensions', () => {
    expect(extFromMime('image/png')).toBe('png')
    expect(extFromMime('image/jpeg')).toBe('jpg')
    expect(extFromMime('image/gif')).toBe('gif')
    expect(extFromMime('image/webp')).toBe('webp')
  })

  it('returns null for anything else', () => {
    expect(extFromMime('image/svg+xml')).toBeNull() // scriptable, backend rejects it too
    expect(extFromMime('text/plain')).toBeNull()
    expect(extFromMime('')).toBeNull()
  })
})

describe('bytesToBase64', () => {
  it('matches Buffer base64 for a small payload', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('is empty for an empty buffer', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })

  it('survives a buffer larger than one 32K chunk (no call-stack blowup)', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251)
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('uploadPastedImage', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], 'clip.png', { type: 'image/png' })

  it('saves next to a saved doc and returns the bare relative name', async () => {
    doc.set(docWith({ path: '/ws/notes/note.md', content: '', savedContent: '' }))
    invoke.mockResolvedValue('note-pasted-1.png')
    await expect(uploadPastedImage(png())).resolves.toBe('note-pasted-1.png')
    expect(invoke).toHaveBeenCalledWith('save_pasted_image', {
      docPath: '/ws/notes/note.md',
      dataB64: Buffer.from([1, 2, 3]).toString('base64'),
      ext: 'png',
    })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to an object URL for an untitled doc (no path to anchor to)', async () => {
    await expect(uploadPastedImage(png())).resolves.toBe('blob:mock-url')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back to an object URL for a mime outside the allowlist', async () => {
    doc.set(docWith({ path: '/ws/note.md' }))
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })
    await expect(uploadPastedImage(svg)).resolves.toBe('blob:mock-url')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports a failed backend write and still returns a visible object URL', async () => {
    doc.set(docWith({ path: '/ws/note.md' }))
    invoke.mockRejectedValue('disk full')
    await expect(uploadPastedImage(png())).resolves.toBe('blob:mock-url')
    expect(get(errorMessage)).toContain('Could not save pasted image')
  })
})

describe('resolveImageSrc', () => {
  it('passes scheme’d URLs through verbatim', () => {
    for (const src of [
      'https://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:mock-url',
      'asset://localhost/x.png',
      '',
    ]) {
      expect(resolveImageSrc(src, '/ws/note.md')).toBe(src)
    }
    expect(convertFileSrc).not.toHaveBeenCalled()
  })

  it('routes an absolute path through convertFileSrc (verbatim would be origin-relative)', () => {
    expect(resolveImageSrc('/abs/path/x.png', '/ws/note.md')).toBe(
      'asset://localhost//abs/path/x.png',
    )
    expect(convertFileSrc).toHaveBeenCalledWith('/abs/path/x.png')
  })

  it('resolves a bare relative name synchronously via convertFileSrc (no backend round-trip)', () => {
    // Same-dir refs are covered by the doc parent's non-recursive asset grant,
    // so they must stay a plain synchronous string — never a Promise.
    expect(resolveImageSrc('note-pasted-1.png', '/ws/notes/note.md')).toBe(
      'asset://localhost//ws/notes/note-pasted-1.png',
    )
    expect(convertFileSrc).toHaveBeenCalledWith('/ws/notes/note-pasted-1.png')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('normalizes ./ prefixes and keeps a same-dir ref on the synchronous path', () => {
    expect(resolveImageSrc('./diagram.png', '/ws/notes/note.md')).toBe(
      'asset://localhost//ws/notes/diagram.png',
    )
    expect(convertFileSrc).toHaveBeenCalledWith('/ws/notes/diagram.png')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('routes a subdirectory link through resolve_image_asset (per-file grant)', async () => {
    invoke.mockResolvedValue('/ws/img/x.png')
    await expect(resolveImageSrc('img/x.png', '/ws/note.md')).resolves.toBe(
      'asset://localhost//ws/img/x.png',
    )
    expect(invoke).toHaveBeenCalledWith('resolve_image_asset', {
      docPath: '/ws/note.md',
      rel: 'img/x.png',
    })
    expect(convertFileSrc).toHaveBeenCalledWith('/ws/img/x.png')
  })

  it('falls back to the joined convertFileSrc URL when the backend rejects (../ escape)', async () => {
    // The command rejects out-of-dir refs; inside a workspace the recursive
    // root grant still renders the fallback URL, elsewhere it fails closed at
    // the asset protocol — either way the fallback is the joined path.
    invoke.mockRejectedValue('image path does not resolve inside the document directory')
    await expect(resolveImageSrc('../img/x.png', '/ws/notes/note.md')).resolves.toBe(
      'asset://localhost//ws/img/x.png',
    )
    expect(invoke).toHaveBeenCalledWith('resolve_image_asset', {
      docPath: '/ws/notes/note.md',
      rel: '../img/x.png',
    })
    expect(convertFileSrc).toHaveBeenCalledWith('/ws/img/x.png')
  })

  it('keeps a subdir/updir ref that normalizes back to the doc dir synchronous', () => {
    // joinRelative collapses img/../x.png to a same-dir ref, so no round-trip.
    expect(resolveImageSrc('img/../x.png', '/ws/notes/note.md')).toBe(
      'asset://localhost//ws/notes/x.png',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns a relative name unchanged when the doc is untitled', () => {
    expect(resolveImageSrc('x.png', null)).toBe('x.png')
    expect(convertFileSrc).not.toHaveBeenCalled()
  })
})
