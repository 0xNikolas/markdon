/**
 * Micro-benchmark for the app's two document-serialization costs, headless
 * (no DOM, no editor view):
 *
 *  1. the WYSIWYG per-PAUSE cost — Crepe's hardwired @milkdown/plugin-listener
 *     runs `serializer(doc)` once, 200ms after the last doc-changing
 *     transaction (NOT per keystroke; its per-transaction apply is O(1)), plus
 *     the `prevDoc.eq(doc)` compare that gates it;
 *  2. the split-mode cost — CodeMirror's `state.doc.toString()`, which
 *     sourceEditor's createDocSync now runs per keystroke only up to
 *     DOC_SYNC_LIMIT and per pause above it.
 *
 * The Milkdown assembly replicates Editor's ctor headlessly: a bare Ctx run
 * through the internal-plugin protocol MINUS editorState/editorView, plus the
 * same commonmark+gfm presets Crepe wires — so serializerCtx/parserCtx are the
 * production serializer/parser. Handlers are fired without Promise.all and we
 * await only SerializerReady, so nothing waits on view timers that never fire.
 *
 * CI runs stay deterministic and quick: a correctness smoke (roundtrip
 * idempotence) plus small corpora with a handful of timed runs, asserting only
 * that timing produced finite numbers — never on the numbers themselves. Set
 * BENCH=1 for the decision-grade run (1M-char corpus, more samples):
 *
 *   BENCH=1 bunx vitest run src/lib/serializePerf.test.ts
 *
 * Decision record (Apple Silicon, node 24, table/list-rich corpus — the
 * serializer's expensive nodes, so a pessimistic mix):
 *
 *   chars      serialize(doc) med/p95    doc.eq clean    cm toString
 *   50K        35ms / 37ms               0.8ms           0.06ms
 *   200K       141ms / 147ms             3.9ms           0.09ms
 *   1M         811ms / 845ms             29ms            0.44ms
 *
 * Read against the plan's gates: CodeMirror's toString is ~0.1ms at 200K
 * (three orders of magnitude under a frame), so split mode's per-keystroke
 * cost was never the problem — the sync limit in createDocSync is cheap
 * insurance, not a rescue. The WYSIWYG per-PAUSE serialize, however, is
 * ~141ms at 200K — well over the ~30ms gate at which the plan's Stage 2
 * (an adaptive-cadence serialization scheduler replacing the listener
 * subscription) becomes worth building; that remains open follow-up work.
 * The flush-before-read fix (bufferFlush.ts) is correct regardless of
 * cadence and is what this sprint shipped.
 */
import { describe, it, expect } from 'vitest'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  SerializerReady,
  commands,
  config,
  editorStateCtx,
  editorViewCtx,
  init,
  keymap,
  parser,
  parserCtx,
  pasteRule,
  schema,
  serializer,
  serializerCtx,
  type Editor,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@codemirror/state'

const BENCH = Boolean(process.env.BENCH)

// @milkdown/ctx timers signal readiness through the GLOBAL event listener API
// (`addEventListener`/`dispatchEvent` — window is an EventTarget in the
// browser). Node has EventTarget/CustomEvent but no global listener
// functions, so bridge a dedicated bus in before any Ctx timer starts.
// `??=` keeps this inert under any future DOM-flavored test environment.
const timerBus = new EventTarget()
const g = globalThis as unknown as Record<string, unknown>
g.addEventListener ??= timerBus.addEventListener.bind(timerBus)
g.removeEventListener ??= timerBus.removeEventListener.bind(timerBus)
g.dispatchEvent ??= timerBus.dispatchEvent.bind(timerBus)

/** Representative markdown (~600 chars): headings, emphasis/links, a nested
 * list, a code fence, and a GFM table — tables and nested lists are the
 * expensive serializer nodes, so the mix leans slightly rich. */
const SECTION = `## Section heading

A paragraph with **strong**, *emphasis*, \`inline code\`, and a
[link](https://example.com/docs) plus some plain prose to keep the
node balance honest across repetitions of this block.

- top item one
- top item two
  - nested item with *emphasis*
  - nested item with a [link](https://example.com)
- top item three

\`\`\`ts
export function greet(name: string): string {
  return \`hello \${name}\`
}
\`\`\`

| Column A | Column B | Column C |
| -------- | -------- | -------- |
| a1       | b1       | c1       |
| a2       | **b2**   | c2       |

`

function corpus(minChars: number): string {
  let out = ''
  while (out.length < minChars) out += SECTION
  return out
}

/** Headless Milkdown: the internal plugins that feed parserCtx/serializerCtx
 * (config → init → schema → parser/serializer/commands/keymap/pasteRule) plus
 * the app's presets. No editorState/editorView — their timers never fire, so
 * we must not await anything downstream of them. */
async function headlessTransformer(): Promise<{
  parse: (md: string) => ProseNode
  serialize: (doc: ProseNode) => string
}> {
  const ctx = new Ctx(new Container(), new Clock())
  // The editorState/editorView internal plugins are deliberately absent (their
  // timers depend on a mounted view), but a few preset serializers probe their
  // slices — commonmark's paragraph reads `ctx.get(editorViewCtx).state?.doc`
  // — so inject the same empty placeholders those plugins start from.
  ctx.inject(editorViewCtx, {} as never).inject(editorStateCtx, {} as never)
  const plugins: MilkdownPlugin[] = [
    config(() => {}),
    init({} as unknown as Editor), // only injected into editorCtx; never dereferenced pre-view
    schema,
    parser,
    serializer,
    commands,
    keymap,
    pasteRule,
    ...commonmark,
    ...gfm,
  ]
  // Run the plugin protocol without Promise.all: handlers that await view-era
  // timers simply stay pending and must not block SerializerReady.
  for (const p of plugins) void p(ctx)()
  await ctx.wait(SerializerReady)
  const parse = ctx.get(parserCtx)
  const serialize = ctx.get(serializerCtx)
  return {
    parse: (md) => parse(md) as ProseNode,
    serialize: (doc) => serialize(doc),
  }
}

function bench(fn: () => void, runs: number, warmup: number): { median: number; p95: number } {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]
  return { median: at(0.5), p95: at(0.95) }
}

const round = (n: number) => Math.round(n * 1000) / 1000

describe('serialization performance', () => {
  it('headless parse/serialize roundtrip is stable (harness self-check)', async () => {
    const { parse, serialize } = await headlessTransformer()
    const md1 = serialize(parse(SECTION))
    expect(md1.length).toBeGreaterThan(0)
    expect(md1).toContain('## Section heading')
    expect(md1).toContain('| Column A')
    // Idempotence: the serializer's own output must roundtrip byte-identical
    // (the same property doc.ts's normalized baseline leans on).
    expect(serialize(parse(md1))).toBe(md1)
  })

  it('doc.eq gates the per-pause serialization (equal and unequal parses)', async () => {
    const { parse } = await headlessTransformer()
    const a = parse(SECTION)
    const b = parse(SECTION)
    expect(a.eq(b)).toBe(true) // clean pause: listener skips serializing
    expect(a.eq(parse(`${SECTION}tail`))).toBe(false)
  })

  it(
    `measures per-pause serializer cost and split-mode toString${BENCH ? '' : ' (smoke sizes; BENCH=1 for the full run)'}`,
    async () => {
      const { parse, serialize } = await headlessTransformer()
      const sizes = BENCH ? [50_000, 200_000, 1_000_000] : [50_000, 200_000]
      const runs = BENCH ? 20 : 3
      const warmup = BENCH ? 5 : 1
      const rows: Record<string, unknown>[] = []
      for (const size of sizes) {
        const md = corpus(size)
        const doc = parse(md)
        const doc2 = parse(md)
        const appended = parse(`${md}tail`)
        const cmDoc = EditorState.create({ doc: md }).doc
        const mdCopy = `${md}` // defeat referential-equality fast paths
        const serializeT = bench(() => serialize(doc), runs, warmup)
        const eqCleanT = bench(() => doc.eq(doc2), runs, warmup)
        const eqDirtyT = bench(() => doc.eq(appended), runs, warmup)
        const cmToStringT = bench(() => cmDoc.toString(), runs, warmup)
        const strCmpT = bench(() => md === mdCopy, runs, warmup)
        rows.push({
          chars: md.length,
          'serialize(doc) med ms': round(serializeT.median),
          'serialize p95 ms': round(serializeT.p95),
          'doc.eq clean med ms': round(eqCleanT.median),
          'doc.eq dirty med ms': round(eqDirtyT.median),
          'cm toString med ms': round(cmToStringT.median),
          'string === med ms': round(strCmpT.median),
        })
        // Deterministic assertions only: timing produced real numbers.
        expect(Number.isFinite(serializeT.median)).toBe(true)
        expect(serializeT.median).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(cmToStringT.median)).toBe(true)
      }
      // The decision record: per-pause serialize cost vs. the ~15ms gate.
      console.table(rows)
    },
    // Parsing the 1M corpus repeatedly is the slow part, not serialization.
    BENCH ? 120_000 : 30_000,
  )
})
