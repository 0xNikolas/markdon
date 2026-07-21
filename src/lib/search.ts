// Pure in-document search logic -- no ProseMirror or DOM imports, so this
// runs under plain vitest. Consumed by searchPlugin.ts, which supplies the
// doc's text as `Segment`s (one run per contiguous inline text stretch).

/** A contiguous run of text extracted from the document. `pos` is the
 * absolute document position of the segment's first character. */
export interface Segment {
  text: string
  pos: number
}

/** A match's absolute document positions, `to` exclusive. */
export interface MatchRange {
  from: number
  to: number
}

/** Case/word-boundary options threading findMatches. Required (not
 * defaulted) so the type-checker enumerates every call site when this
 * shape changes -- a defaulted param would hide missed callers. */
export interface MatchOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

// CM-aligned word-char test (node_modules/@codemirror/state's wordChar):
// Alphabetic/Number/underscore are word chars; everything else (space,
// punctuation, the string edge) is a boundary. This keeps WYSIWYG whole-word
// behavior identical to CodeMirror's split-mode search panel.
const WORD = /[\p{Alphabetic}\p{Number}_]/u
function isWordChar(ch: string): boolean {
  return ch !== '' && WORD.test(ch)
}

// CM stringWordTest parity (@codemirror/search's stringWordTest): a match
// [from,to) qualifies iff there is a word-boundary transition at `from` AND
// at `to`, where the string edge counts as a boundary. Runs against the
// run's ORIGINAL-cased text (not the lowercased search haystack) so an edge
// char's Unicode category is never affected by case-folding.
function isWholeWord(text: string, from: number, to: number): boolean {
  const before = from > 0 ? text[from - 1] : ''
  const first = text[from]
  const last = text[to - 1]
  const after = to < text.length ? text[to] : ''
  const startOk = !isWordChar(before) || !isWordChar(first)
  const endOk = !isWordChar(after) || !isWordChar(last)
  return startOk && endOk
}

/**
 * Literal search over `segments`, honoring `opts.caseSensitive` and
 * `opts.wholeWord`. Position-adjacent segments (no gap between one's end and
 * the next's start) are coalesced into a single search run, so a match can
 * span a mark boundary (e.g. bold text abutting plain text). A gap -- a hard
 * break, inline atom, or block boundary -- ends the run, so matches never
 * span one. Matches within a run are non-overlapping, resuming right after
 * the previous match ends (whole-word filtering is a post-filter and does
 * not change that scan cadence).
 */
export function findMatches(segments: Segment[], query: string, opts: MatchOptions): MatchRange[] {
  if (query.length === 0) return []
  const q = opts.caseSensitive ? query : query.toLowerCase()
  const matches: MatchRange[] = []

  let run: Segment[] = []
  const flush = () => {
    if (run.length === 0) return
    const raw = run.map((s) => s.text).join('')
    const hay = opts.caseSensitive ? raw : raw.toLowerCase()
    const start = run[0].pos // offset -> doc position is affine per run
    let i = 0
    while ((i = hay.indexOf(q, i)) !== -1) {
      const end = i + q.length
      // Whole-word test runs against the ORIGINAL-cased run text `raw`.
      if (!opts.wholeWord || isWholeWord(raw, i, end)) matches.push({ from: start + i, to: start + end })
      i = end // non-overlapping: resume after this candidate, matched or not
    }
    run = []
  }

  for (const seg of segments) {
    const prev = run[run.length - 1]
    if (prev && prev.pos + prev.text.length !== seg.pos) flush()
    run.push(seg)
  }
  flush()

  return matches
}

/** Wrapping step from `current` by `delta` (+1/-1) over `count` matches.
 * Returns -1 when there are no matches to step through. */
export function stepIndex(count: number, current: number, delta: 1 | -1): number {
  if (count === 0) return -1
  return (current + delta + count) % count
}
