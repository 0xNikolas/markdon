// Pure argument -> launch-plan logic for the `md` CLI launcher (scripts/md).
//
// Kept dependency-free and side-effect-free (all filesystem/env access is
// injected) so it can be unit-tested from src/lib/mdCli.test.ts under vitest
// without touching a real disk or spawning the app. scripts/md wires the real
// node:fs / node:os / process values into these functions.
//
// Routing rule — mirrors src-tauri/src/launch.rs::parse_launch_args, which is
// the TESTED consumer on the Rust side and is NOT changed by this launcher:
//   - a FILE  -> passed as a positional argv entry (launch.rs keeps positional
//                args that name an existing regular file and opens them).
//   - a DIR   -> passed as `--workspace <absdir>` (launch.rs drops positional
//                directories, so a folder MUST go through the flag).
// Because launch.rs takes "last --workspace wins" and validates nothing here,
// we resolve every path to an absolute path first and reject more than one
// directory per invocation rather than silently dropping all but the last.

import { resolve, join } from 'node:path'

/** Tagged error so scripts/md can map a failure to an exit code + stderr line.
 * @typedef {'no-path'|'not-found'|'multi-dir'|'no-binary'} MdErrorCode */
export class MdError extends Error {
  /** @param {MdErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'MdError'
  }
}

export const USAGE = `Usage: md <path> [<path>...]

Open markdown files or a folder in the Markdon app (each launch opens a new
app instance / window).

  md notes.md              open a file
  md ./project             open a folder as a workspace
  md a.md b.md ./docs      open several files plus a workspace folder

Environment:
  MARKDON_BIN   path to the Markdon app binary (overrides the default lookup)`

/**
 * Build the argv to hand to the Markdon binary from the user's path arguments.
 * Files become positional args; a single directory becomes `--workspace <dir>`.
 * Every path is resolved to an absolute path against `cwd`.
 *
 * @param {string[]} rawPaths  the path operands from the command line
 * @param {{ cwd: string, probe: (absPath: string) => ('file'|'dir'|null) }} deps
 *        `probe` returns the kind of an absolute path, or null if it is missing.
 * @returns {string[]} argv for the Markdon binary
 */
export function buildArgv(rawPaths, { cwd, probe }) {
  if (!rawPaths || rawPaths.length === 0) {
    throw new MdError('no-path', 'no path given')
  }
  /** @type {string[]} */ const files = []
  /** @type {string[]} */ const dirs = []
  for (const raw of rawPaths) {
    const abs = resolve(cwd, raw)
    const kind = probe(abs)
    if (kind === null) {
      throw new MdError('not-found', `path does not exist: ${raw}`)
    }
    if (kind === 'dir') dirs.push(abs)
    else files.push(abs)
  }
  if (dirs.length > 1) {
    throw new MdError(
      'multi-dir',
      `only one folder can be opened per launch (got ${dirs.length}); ` +
        'run `md` once per folder',
    )
  }
  /** @type {string[]} */ const argv = []
  if (dirs.length === 1) argv.push('--workspace', dirs[0])
  argv.push(...files)
  return argv
}

/**
 * The ordered list of candidate paths for the installed Markdon binary.
 * macOS-first (the primary target); MARKDON_BIN short-circuits the search.
 * Linux/Windows locations are intentionally NOT probed here — see README.
 *
 * @param {{ env: Record<string, string | undefined>, home: string }} deps
 * @returns {string[]}
 */
export function binaryCandidates({ env, home }) {
  if (env.MARKDON_BIN) return [env.MARKDON_BIN]
  const rel = 'Markdon.app/Contents/MacOS/app'
  return [join('/Applications', rel), join(home, 'Applications', rel)]
}

/**
 * Locate the Markdon binary, returning the first candidate that exists.
 *
 * @param {{ env: Record<string, string | undefined>, home: string, exists: (p: string) => boolean }} deps
 * @returns {string}
 */
export function findBinary({ env, home, exists }) {
  const candidates = binaryCandidates({ env, home })
  for (const c of candidates) if (exists(c)) return c
  throw new MdError(
    'no-binary',
    'Markdon app binary not found. Looked in:\n  ' +
      candidates.join('\n  ') +
      '\nInstall Markdon.app, or set MARKDON_BIN to the binary path.',
  )
}
