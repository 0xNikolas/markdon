// Image paste-to-file (VS Code-like): pasting an image into the WYSIWYG editor
// of a SAVED document writes `<stem>-pasted-<n>.<ext>` next to the document
// (fileops::save_pasted_image) and returns the bare relative name for the
// markdown link -- instead of Crepe's default of inlining a multi-MB data: URI
// on ONE line, which is exactly what made Split Preview freeze WebKit (see
// sourceEditor's LONG_LINE_LIMIT).
//
// KNOWN LIMITATION (deliberate, not fixed here): images pasted into an
// untitled doc have no directory to land in, so they stay blob:-backed for the
// session and die on reload. Relatively-linked images render for any doc
// inside a granted directory — the backend issues an asset-protocol grant
// (display-only, runtime-only) recursively for every opened workspace root but
// NON-recursively for a single opened/saved file's parent dir (so opening
// ~/note.md never exposes the whole home tree to the display channel), plus a
// per-file grant for each pasted image and for each subdirectory image ref
// resolved through resolve_image_asset.
import { convertFileSrc } from '@tauri-apps/api/core'
import * as ipc from './ipc'
import { get } from 'svelte/store'
import { doc } from './doc'
import { reportFailure } from './errors'
import { joinRelative, dirname } from './paths'

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
    return await ipc.savePastedImage(docPath, dataB64, ext)
  } catch (e) {
    reportFailure('save pasted image', e)
    return URL.createObjectURL(file)
  }
}

/**
 * Crepe ImageBlock `proxyDomURL`: map a markdown image src to what the <img>
 * tag should actually load. A scheme'd URL (http://, data:, blob:, asset:,
 * ...) passes through verbatim; an absolute path goes through convertFileSrc
 * (verbatim it would be origin-relative in the webview and never render).
 *
 * Relative srcs split on where they resolve to (proxyDomURL accepts both a
 * string and a Promise<string>, so the split can stay per-src):
 * - SAME directory as the doc (after joinRelative normalization): synchronous
 *   convertFileSrc — the doc's parent dir always carries at least a
 *   non-recursive asset grant, so this renders for every open route.
 * - a subdirectory (or `../`): async via the resolve_image_asset command,
 *   which canonicalizes, verifies the target stays inside the doc's
 *   directory, grants display access to THAT FILE only, and returns the
 *   absolute path for convertFileSrc. This is what lets a single-file open
 *   get by WITHOUT a recursive grant over its parent tree. On rejection
 *   (`../` escape, missing file) fall back to the plain convertFileSrc URL:
 *   inside a workspace the recursive root grant still renders it; anywhere
 *   else the asset protocol fails closed exactly as before.
 *
 * Percent-decoding: markdown srcs are URLs, so editors write `my image.png`
 * as `my%20image.png` — but convertFileSrc encodeURIComponent-encodes the
 * whole path and the Rust asset handler decodes exactly once, so passing the
 * still-encoded src through would double-encode (`my%2520image.png`) and 404
 * against the on-disk `my image.png`. Non-scheme'd srcs are therefore decoded
 * once here before any path handling. The flip side is standard URL
 * semantics: a file literally NAMED `my%20image.png` must be referenced as
 * `my%2520image.png`.
 *
 * A resolved path whose file is missing (or ungranted) fails the asset
 * scope/read silently: the <img> errors and Crepe shows its broken-image
 * state — no banner, no retry; the image appears only once the node
 * re-renders after the file exists. Fail closed, by design.
 */
export function resolveImageSrc(src: string, docPath: string | null): string | Promise<string> {
  if (src === '' || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src
  const decoded = decodePercent(src)
  if (decoded.startsWith('/')) return convertFileSrc(decoded)
  // No doc path (untitled) -> nothing to resolve against; return unchanged
  // (the link is broken either way, but never fabricate a path).
  if (docPath === null) return src
  const dir = dirname(docPath)
  const joined = joinRelative(dir, decoded)
  if (dirname(joined) === dir) return convertFileSrc(joined)
  return ipc.resolveImageAsset(docPath, decoded).then(
    (resolved) => convertFileSrc(resolved),
    () => convertFileSrc(joined),
  )
}

// decodeURIComponent, not decodeURI: this only runs AFTER the scheme'd-URL
// passthrough, so the string is a bare file path where URI-reserved
// characters carry no structural meaning — decodeURI would leave %3F/%23
// encoded even though `?` and `#` are legal macOS filename chars, and a
// decoded %2F just behaves as a path separator (containment is enforced by
// resolve_image_asset's canonicalization, not by string shape). A stray `%`
// without two hex digits (`100%.png`) makes decodeURIComponent throw, and
// such srcs are kept verbatim so those files keep rendering.
function decodePercent(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}
