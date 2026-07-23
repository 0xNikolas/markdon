import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Enforcement over convention: the browser-side Tauri stub
// (e2e/support/tauriInternals.js) carries hand-written "mirrors Rust VERBATIM"
// comments and a command table that must stay in lockstep with the real
// `generate_handler!` registration in src-tauri/src/lib.rs. Those comments are
// only a promise; this test is the gate. It reads every source file as TEXT
// (readFileSync + regex) — never importing across the e2e / src / Rust project
// boundaries, matching the precedent in src/lib/icons.test.ts — so svelte-check
// and the tsconfig projects stay untouched while drift still goes red here, in
// the fast vitest suite, before any cold e2e boot.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..') // src/lib/test-support -> repo root
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

// Registered commands the stub deliberately does NOT handle — the partition
// that makes stubSet a strict subset of handlerSet rather than an equal set.
// This test is the sole consumer of the allowlist, so it lives here with its
// rationale. If a future smoke/e2e flow starts invoking one of these, the stub
// must gain a handler AND the command must move out of this list, or the
// partition assertion below goes red (a feature: it forces the pairing).
const UNSTUBBED = [
  'open_file_dialog',
  'save_file_dialog',
  'open_workspace_dialog', // native OS dialogs — never invoked in headless smoke
  'read_history_version',
  'export_pdf', // not exercised by any current smoke/e2e flow
]

/** The `generate_handler![ ... ]` command names, module:: prefixes stripped. */
function parseHandlerSet(libRs: string): Set<string> {
  const open = libRs.indexOf('generate_handler![')
  if (open === -1) throw new Error('generate_handler! block not found in lib.rs')
  const close = libRs.indexOf(']', open)
  if (close === -1) throw new Error('generate_handler! block not closed in lib.rs')
  const body = libRs.slice(open + 'generate_handler!['.length, close)
  const names = body
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // strip any `module::` path prefixes, keep the bare command name
    // (split/pop leaves prefix-less names — take_opened_files — intact)
    .map((s) => s.split('::').pop() as string)
  return new Set(names)
}

/** The top-level keys of the stub's `const commands = { ... }` table. */
function parseStubKeys(stub: string): Set<string> {
  const open = stub.indexOf('const commands = {')
  if (open === -1) throw new Error('`const commands = {` not found in tauriInternals.js')
  // The commands object closes right before __TAURI_INTERNALS__ is assigned;
  // bounding the slice here excludes that object's own 4-space-indented keys
  // (metadata:, plugins:, ...) from the key match below.
  const end = stub.indexOf('window.__TAURI_INTERNALS__', open)
  if (end === -1) throw new Error('commands object close not found in tauriInternals.js')
  const body = stub.slice(open, end)
  // Top-level command keys are exactly 4-space-indented `name:`; handler bodies
  // and inline object props sit at 6+ spaces, so this anchor excludes them.
  const keys = new Set<string>()
  for (const m of body.matchAll(/^ {4}(\w+):/gm)) keys.add(m[1])
  return keys
}

describe('tauri stub command contract', () => {
  const libRs = read('src-tauri/src/lib.rs')
  const stub = read('e2e/support/tauriInternals.js')
  const handlerSet = parseHandlerSet(libRs)
  const stubSet = parseStubKeys(stub)

  it('parses the expected command counts (parser sanity)', () => {
    // 43 registered Rust commands, 38 stubbed, 5 deliberately unstubbed.
    expect(handlerSet.size).toBe(43)
    expect(stubSet.size).toBe(38)
    expect(UNSTUBBED).toHaveLength(5)
  })

  it('every stubbed command is a real registered command', () => {
    // Catches a renamed/typo'd stub key — drift the smoke suite only trips over
    // if a boot flow happens to invoke that exact command.
    const extra = [...stubSet].filter((c) => !handlerSet.has(c))
    expect(extra).toEqual([])
  })

  it('stub + unstubbed allowlist partitions the full handler set', () => {
    // Catches a NEW Rust command the stub does not handle: it would be absent
    // from both the stub table and the allowlist, so the union falls short.
    const covered = new Set([...stubSet, ...UNSTUBBED])
    expect([...covered].sort()).toEqual([...handlerSet].sort())
  })

  it('every unstubbed allowlist entry is a real registered command', () => {
    // Keeps the allowlist honest — no stale entry for a removed command.
    const orphan = UNSTUBBED.filter((c) => !handlerSet.has(c))
    expect(orphan).toEqual([])
  })

  it('pins the no-clobber string across Rust, the stub, and the e2e shared module', () => {
    // Extract the stub's literal, then require the same substring in the Rust
    // source-of-truth and the importable e2e constant. Substring (not literal
    // parsing) so incidental formatting in fileops.rs cannot false-positive.
    const m = stub.match(/const NO_CLOBBER = '([^']*)'/)
    expect(m).not.toBeNull()
    const stubNoClobber = m![1]
    expect(stubNoClobber.length).toBeGreaterThan(0)
    expect(read('src-tauri/src/fileops.rs')).toContain(stubNoClobber)
    expect(read('e2e/support/contract.ts')).toContain(stubNoClobber)
  })
})
