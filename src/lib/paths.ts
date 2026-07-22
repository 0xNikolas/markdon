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
