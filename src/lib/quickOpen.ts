import type { WorkspaceDir } from './workspace'
import { isMarkdownFile } from './workspace'

/**
 * Pure helpers behind the ⌘P Quick Open palette: flatten the workspace tree
 * into openable candidates and fuzzy-rank them against the typed query.
 * No stores, no IPC, no dependencies — QuickOpen.svelte renders what these
 * return and nothing else, so every ranking rule is unit-testable here.
 */

/** One palette candidate. */
export interface QuickOpenItem {
  /** Absolute path — what opening acts on. */
  path: string
  /** Basename, rendered strong (e.g. "nested.md"). */
  name: string
  /**
   * Workspace-relative parent directory, rendered muted after the name
   * (e.g. "sub", "docs/guides"); '' for files directly under the root.
   */
  dir: string
}

/**
 * Result-list cap, shared by the empty-query listing and ranked results: the
 * palette renders ~12 rows and scrolls, so anything beyond 50 is noise the
 * user will re-type past anyway — and capping keeps huge trees cheap.
 */
export const QUICK_OPEN_CAP = 50

/**
 * Flatten the workspace tree into palette candidates, in the sidebar's
 * display order (a directory's subdirectories first, depth-first, then its
 * files — the same walk as fileTree.ts's visibleRowPaths, but ignoring
 * collapse state: Quick Open searches the whole tree, not what happens to be
 * expanded). ONLY markdown files are listed — they are the only rows the
 * editor can open (workspace.ts isMarkdownFile; non-md files render in the
 * sidebar for context but never as palette entries).
 */
export function flattenMarkdownFiles(tree: WorkspaceDir | null): QuickOpenItem[] {
  if (tree === null) return []
  const out: QuickOpenItem[] = []
  const walk = (d: WorkspaceDir, dir: string): void => {
    for (const sub of d.dirs) walk(sub, dir === '' ? sub.name : `${dir}/${sub.name}`)
    for (const f of d.files) {
      if (isMarkdownFile(f.name)) out.push({ path: f.path, name: f.name, dir })
    }
  }
  walk(tree, '')
  return out
}

/** The workspace-relative display path a query is matched against. */
function displayPath(item: QuickOpenItem): string {
  return item.dir === '' ? item.name : `${item.dir}/${item.name}`
}

// Per-character scoring. A matched character always scores BASE; landing
// right after the previous match adds CONSECUTIVE (typed runs beat scattered
// letters); landing at a path-segment start adds SEGMENT and at a word start
// (after -, _, . or space) adds WORD. Magnitudes only matter relative to each
// other — name-beats-dir is a sort TIER (see fuzzyRank), not a bonus, so no
// bonus arms race is possible.
const BASE = 1
const CONSECUTIVE = 5
const SEGMENT = 4
const WORD = 2

/**
 * Greedy left-to-right subsequence match of `query` against `target` (both
 * lowercase), scored with the bonuses above. Returns null when `query` is
 * not a subsequence of `target`. Greedy leftmost matching is deliberate:
 * optimal-alignment scoring (à la fzf) buys little on paths this short and
 * costs O(n·m) state — "sensible", not "perfect", is the contract.
 */
function scoreMatch(query: string, target: string): number | null {
  let score = 0
  let from = 0
  let prev = -2 // never adjacent to index 0
  for (let qi = 0; qi < query.length; qi++) {
    const at = target.indexOf(query[qi], from)
    if (at === -1) return null
    score += BASE
    if (at === prev + 1) score += CONSECUTIVE
    const before = at === 0 ? '/' : target[at - 1]
    if (before === '/') score += SEGMENT
    else if (before === '-' || before === '_' || before === '.' || before === ' ') score += WORD
    prev = at
    from = at + 1
  }
  return score
}

/**
 * Rank `items` against `query`, case-insensitively, returning at most
 * {@link QUICK_OPEN_CAP} results.
 *
 * Empty query: the tree order as given (no recency tracking — the buffer
 * cache makes any choice instant), except the currently-active file
 * (`activePath`) is moved LAST — VS Code parity: the file you are already in
 * is the one you least mean to "jump" to, so it yields the top slots.
 *
 * Non-empty query: subsequence match against the workspace-relative display
 * path (`dir/name`), scored per character (consecutive runs and word/segment
 * starts score higher — see scoreMatch). Items whose BASENAME alone contains
 * the query as a subsequence form a strictly higher tier than dir-only
 * matches ("name-match beats dir-match", guaranteed by tiering rather than a
 * bonus constant that a long query could swamp). Ties break to the shorter
 * display path, then to tree order. The active file gets no special
 * treatment once a query is typed — it competes like any other row.
 */
export function fuzzyRank(
  query: string,
  items: QuickOpenItem[],
  activePath: string | null = null,
): QuickOpenItem[] {
  if (query === '') {
    const rest = items.filter((i) => i.path !== activePath)
    const active = items.filter((i) => i.path === activePath)
    return [...rest, ...active].slice(0, QUICK_OPEN_CAP)
  }
  const q = query.toLowerCase()
  const scored: { item: QuickOpenItem; inName: boolean; score: number; len: number; ord: number }[] =
    []
  for (let ord = 0; ord < items.length; ord++) {
    const item = items[ord]
    const display = displayPath(item).toLowerCase()
    const score = scoreMatch(q, display)
    if (score === null) continue
    const inName = scoreMatch(q, item.name.toLowerCase()) !== null
    scored.push({ item, inName, score, len: display.length, ord })
  }
  scored.sort(
    (a, b) =>
      Number(b.inName) - Number(a.inName) || b.score - a.score || a.len - b.len || a.ord - b.ord,
  )
  return scored.slice(0, QUICK_OPEN_CAP).map((s) => s.item)
}
