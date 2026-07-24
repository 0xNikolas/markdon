/**
 * Shared, dependency-free path predicates. A leaf module (no imports) so
 * every layer — doc.ts, openList.ts, fileops.ts — can depend on it without
 * risking an import cycle.
 */

/** True when `child` is `ancestor` itself or nested beneath it (segment-safe). */
export function isSelfOrDescendant(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + '/')
}

/**
 * True when `path` is `root` or nested under it, matched segment-by-segment
 * (not by string prefix, so a sibling folder like `/ws/project2` isn't
 * mistaken for a child of `/ws/proj`). A segment-less root ('/' or '') would
 * make the check vacuously true for every path, so it always returns false
 * instead — an empty/root root never counts as containing anything.
 *
 * Deliberately distinct from isSelfOrDescendant above, which the two must NOT
 * be merged into: isSelfOrDescendant is a raw string-prefix test
 * (`child === ancestor || child.startsWith(ancestor + '/')`), so an empty
 * `ancestor` is a prefix of every absolute path and matches everything;
 * isInsideRoot is segment-based and returns false for an empty/root root. The
 * segment semantics are what let fileBreadcrumb fall back safely when the
 * workspace root is '/' or ''.
 */
export function isInsideRoot(path: string, root: string): boolean {
  const pathSegments = path.split('/').filter(Boolean)
  const rootSegments = root.split('/').filter(Boolean)
  return rootSegments.length > 0 && rootSegments.every((seg, i) => pathSegments[i] === seg)
}

/**
 * Rewrite `path` under a moved `oldPrefix` -> `newPrefix`: an exact match
 * becomes `newPrefix`; a path nested beneath `oldPrefix` keeps its suffix
 * under `newPrefix`; anything else is returned unchanged. Segment-safe — the
 * trailing-slash check means `/ws/proj` never matches `/ws/proj2`.
 */
export function rewritePrefix(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix
  if (path.startsWith(oldPrefix + '/')) return newPrefix + path.slice(oldPrefix.length)
  return path
}

/**
 * Resolve a relative POSIX path `rel` against absolute directory `dir` into a
 * normalized absolute path: '' and '.' segments are dropped, '..' pops the
 * accumulated segments (clamping at '/'). Deterministic normalization matters
 * because the asset-protocol scope glob-matches the literal path when the
 * target file does not exist — an un-normalized `dir/./x.png` would be
 * fragile there. POSIX-only, like every path in this module.
 */
export function joinRelative(dir: string, rel: string): string {
  const out = dir.split('/').filter((s) => s !== '')
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop() // already-empty pop clamps at '/'
    } else {
      out.push(seg)
    }
  }
  return '/' + out.join('/')
}

/**
 * Every directory strictly between `root` and `path` (exclusive of both),
 * ordered outermost first — e.g. `/ws` + `/ws/a/b/c.md` -> `/ws/a`, `/ws/a/b`.
 * Segment-safe: a path outside `root` (including a sibling that merely shares
 * a name prefix) yields `[]`, as does a direct child of the root. Used by the
 * sidebar to expand every collapsed ancestor before mounting a rename input.
 */
export function ancestorDirs(root: string, path: string): string[] {
  if (!path.startsWith(root + '/')) return []
  const out: string[] = []
  let cur = path
  for (;;) {
    const slash = cur.lastIndexOf('/')
    if (slash <= root.length) break
    cur = cur.slice(0, slash)
    out.push(cur)
  }
  return out.reverse()
}

/**
 * Final path segment, trailing slashes ignored — segment-based (NOT
 * lastIndexOf) so `/a/dir/` -> `dir`. `''` and `/` yield `''`.
 */
export function basename(p: string): string {
  const segs = p.split('/').filter(Boolean)
  return segs.length > 0 ? segs[segs.length - 1] : ''
}

/**
 * Parent directory, no trailing slash. A top-level file or bare segment yields
 * `''`; never returns `'/'`. POSIX.
 */
export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : ''
}

/**
 * Stem + extension of a basename. Only a NON-leading dot counts (a leading-dot
 * dotfile like `.gitignore` has no extension); `ext` excludes the dot.
 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot + 1) } : { stem: name, ext: '' }
}

/** Header breadcrumb: muted segments before the filename, plus the filename itself. */
export interface FileBreadcrumb {
  crumbs: string[]
  filename: string
}

/**
 * Header breadcrumb segments for the open document.
 *
 * - No path (untitled doc): no crumbs, filename "Untitled".
 * - Path inside the open workspace: crumbs are the workspace root name plus
 *   every intermediate folder between the root and the file (path relative to
 *   `workspaceRoot`), so nested files show their full in-workspace ancestry.
 * - Anything else — no workspace open, or a path outside the workspace root
 *   (see `isInsideRoot`) — falls back to just the immediate parent folder, so
 *   the header never leaks a long absolute path.
 */
export function fileBreadcrumb(
  path: string | null,
  workspaceRoot: string | null,
  workspaceName: string | null,
): FileBreadcrumb {
  if (path === null) return { crumbs: [], filename: 'Untitled' }

  const segments = path.split('/').filter(Boolean)
  const filename = segments[segments.length - 1] ?? path

  if (workspaceRoot !== null && workspaceName !== null && isInsideRoot(path, workspaceRoot)) {
    const rootSegments = workspaceRoot.split('/').filter(Boolean)
    const dirs = segments.slice(rootSegments.length, -1)
    return { crumbs: [workspaceName, ...dirs], filename }
  }

  const parent = segments[segments.length - 2]
  return { crumbs: parent ? [parent] : [], filename }
}

/**
 * Native window title: filename (or "Untitled"), a leading bullet while the
 * doc has unsaved changes, and an " — Markdon" suffix so taskbar/Mission
 * Control entries stay identifiable. The dirty marker lives in the title text
 * because Tauri 2's JS API has no setDocumentEdited (macOS proxy-icon)
 * equivalent.
 *
 * `empty` (the emptyState store) wins over everything: the empty page has no
 * document at all, so the title is plain "Markdon" — not "Untitled", which
 * names a real (editable) scratch buffer.
 */
export function windowTitle(path: string | null, dirty: boolean, empty = false): string {
  if (empty) return 'Markdon'
  const name = (path !== null ? basename(path) : '') || 'Untitled'
  return `${dirty ? '• ' : ''}${name} — Markdon`
}
