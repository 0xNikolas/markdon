// Image paste-to-file (VS Code-like): pasting an image into the WYSIWYG editor
// of a SAVED document writes `<stem>-pasted-<n>.<ext>` next to the document
// (fileops::save_pasted_image) and returns the bare relative name for the
// markdown link -- instead of Crepe's default of inlining a multi-MB data: URI
// on ONE line, which is exactly what made Split Preview freeze WebKit (see
// sourceEditor's LONG_LINE_LIMIT).
//
// KNOWN LIMITATION (deliberate, not fixed here): images pasted into an
// untitled doc have no directory to land in, so they stay blob:-backed for the
// session and die on reload; and relatively-linked images only render for
// documents whose paths the backend has allowlisted (asset-protocol grants are
// runtime-only, issued per pasted file).
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { get } from 'svelte/store'
import { doc } from './doc'
import { reportError } from './errors'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File extension for a pasteable image mime type, or null for anything the
 * backend's extension allowlist would reject anyway. Pure. */
export function extFromMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null
}

/** Base64 of `bytes`, fed to btoa in 32K-char chunks: spreading a whole
 * MB-scale buffer into one String.fromCharCode call would blow the call
 * stack. Pure. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Crepe ImageBlock `onUpload`: persist the pasted/uploaded image and return
 * the URL to put in the markdown. Saved doc + known image type -> a real file
 * next to the document, linked by bare relative name (resolveImageSrc turns
 * it back into a displayable URL at render time). Untitled doc or exotic mime
 * -> a session-only object URL, so the paste still visibly works (see the
 * known-limitation note above); same graceful degradation when the backend
 * write fails, after surfacing the error the way files.ts does.
 */
export async function uploadPastedImage(file: File): Promise<string> {
  const docPath = get(doc).path
  const ext = extFromMime(file.type)
  if (docPath === null || ext === null) return URL.createObjectURL(file)
  try {
    const dataB64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
    return await invoke<string>('save_pasted_image', { docPath, dataB64, ext })
  } catch (e) {
    reportError(`Could not save pasted image: ${String(e)}`)
    return URL.createObjectURL(file)
  }
}

/**
 * Crepe ImageBlock `proxyDomURL`: map a markdown image src to what the <img>
 * tag should actually load. Anything self-describing -- a scheme'd URL
 * (http://, data:, blob:, asset:, ...) or an absolute path -- passes through
 * verbatim; a bare relative name (what uploadPastedImage writes) resolves
 * against the document's parent directory and goes through convertFileSrc so
 * the webview loads it via the asset protocol. Pure over its inputs.
 */
export function resolveImageSrc(src: string, docPath: string | null): string {
  if (src === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('/')) return src
  // No doc path (untitled) -> nothing to resolve against; return unchanged
  // (the link is broken either way, but never fabricate a path).
  if (docPath === null) return src
  const dir = docPath.slice(0, docPath.lastIndexOf('/'))
  return convertFileSrc(`${dir}/${src}`)
}
