// Enabled under vitest (process.env.NODE_ENV === 'test') and any non-production
// Vite build (import.meta.env.DEV) — both are statically replaced at build
// time, so every `if (ASSERT_INVARIANTS && …)` branch that reads this stays
// dead code (and is tree-shaken away) in a production Tauri build, and runs
// under `vitest run`'s node environment where import.meta.env.DEV is also true,
// but process.env.NODE_ENV is the more direct signal there.
//
// The shared env seam for the cross-store invariant assertions (bufferCache
// stash ⊆ openList, openList preview ∉ pinned). Mirrors doc.ts's own local
// ASSERT_INVARIANTS verbatim so all sites gate identically. Exported as a bare
// CONSTANT, never a helper: the assertion body must be inlined behind
// `if (ASSERT_INVARIANTS && …)` at each call site so the whole branch —
// including any store reads — is eliminated in production. A helper would move
// the gate inside and force the (potentially expensive) condition to evaluate
// in prod.
export const ASSERT_INVARIANTS: boolean =
  Boolean(import.meta.env?.DEV) || process.env.NODE_ENV === 'test'
