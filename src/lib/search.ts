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

/**
 * Case-insensitive literal search over `segments`. Position-adjacent
 * segments (no gap between one's end and the next's start) are coalesced
 * into a single search run, so a match can span a mark boundary (e.g. bold
 * text abutting plain text). A gap -- a hard break, inline atom, or block
 * boundary -- ends the run, so matches never span one. Matches within a run
 * are non-overlapping, resuming right after the previous match ends.
 */
export function findMatches(segments: Segment[], query: string): MatchRange[] {
  if (query.length === 0) return []
  const q = query.toLowerCase()
  const matches: MatchRange[] = []

  let run: Segment[] = []
  const flush = () => {
    if (run.length === 0) return
    const text = run.map((s) => s.text).join('').toLowerCase()
    const start = run[0].pos // offset -> doc position is affine per run
    let i = 0
    while ((i = text.indexOf(q, i)) !== -1) {
      matches.push({ from: start + i, to: start + i + q.length })
      i += q.length // non-overlapping: resume after this match
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
