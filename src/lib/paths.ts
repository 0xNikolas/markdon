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
