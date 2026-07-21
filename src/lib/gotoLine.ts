/**
 * Pure parse/clamp logic for the Go to Line popover (GoToLineBar.svelte).
 * No DOM/CodeMirror/ProseMirror imports -- the CM-side apply lives in
 * sourceEditor.ts's gotoPos, which mirrors CM's own gotoLine clamp idiom.
 */

export interface GotoTarget {
  /** 1-based, matches CodeMirror's Text.line(n) and the status bar's Ln. */
  line: number
  /** 0-based, matches the status bar's Col and CM's own gotoLine offset. */
  col: number
}

const GOTO_RE = /^(\d+)(?::(\d+)?)?$/

/**
 * Parse "N" or "N:C" ("N:" is C omitted -> col 0). Rejects empty/whitespace,
 * non-numeric input, a missing line before the colon, line < 1, and a
 * negative col. An out-of-range HIGH line is intentionally NOT a parse
 * error -- it's clamped at apply time (gotoPos) so "go to 99999" lands on
 * the last line instead of erroring.
 */
export function parseGoto(input: string): GotoTarget | null {
  const s = input.trim()
  const m = GOTO_RE.exec(s)
  if (!m) return null
  const line = Number(m[1])
  if (line < 1) return null
  return { line, col: m[2] ? Number(m[2]) : 0 }
}

/** Line count for the popover's "1–N" range hint. Matches CM's Text.lines
 * (a trailing newline counts as a trailing empty line). */
export function lineCount(content: string): number {
  return content.split('\n').length
}

/** Clamp `line` into [1, totalLines]. Pure mirror of gotoPos's line clamp,
 * used by the popover to preview where an out-of-range entry will land. */
export function clampLine(line: number, totalLines: number): number {
  return Math.max(1, Math.min(totalLines, line))
}
