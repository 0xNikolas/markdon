// Last-written echo suppressor. Two shared-file designs (settings.ts's prefs
// file, workspace.ts's per-workspace ui.json) persist a serialized snapshot and
// must NOT save back a value they just APPLIED from that same file — the apply
// re-runs the subscriber, whose write would echo straight back (a write storm,
// or worse a self-clobber). Both hand-rolled the same two-statement pattern:
// `if (serialized === last) return; last = serialized`. This is that predicate
// plus its stamp, extracted verbatim.
//
// `shouldWrite` is a PURE predicate (no mutation); `stamp` is the only mutator.
// They are kept separate rather than auto-stamping so the pre-stamp path (apply
// a remote value, stamp it, let the resulting subscriber run suppress) reads as
// a single explicit stamp — folding the stamp into the predicate would either
// double-stamp there or blur when the slot advances.

/** Single-slot echo guard (settings.ts: one prefs blob, optionally seeded). */
export interface EchoGuard {
  /** True when `serialized` differs from the last stamped value — i.e. worth writing. */
  shouldWrite(serialized: string): boolean
  /** Record `serialized` as the last written/applied value. */
  stamp(serialized: string): void
}

/**
 * Create a single-slot guard. `seed` pre-stamps the initial value so the first
 * `shouldWrite(seed)` returns false — settings.ts seeds with the boot
 * serialization so the initial subscriber run never pushes the stale boot cache
 * over the file before the reconcile has read it.
 */
export function createEchoGuard(seed?: string | null): EchoGuard {
  let last: string | null = seed ?? null
  return {
    shouldWrite: (serialized) => serialized !== last,
    stamp: (serialized) => {
      last = serialized
    },
  }
}

/** Map-backed echo guard keyed by K (workspace.ts: one slot per workspace root). */
export interface KeyedEchoGuard<K> {
  /** True when `serialized` differs from the last value stamped under `key`. */
  shouldWrite(key: K, serialized: string): boolean
  /** Record `serialized` as the last written/applied value for `key`. */
  stamp(key: K, serialized: string): void
  /** Forget every key's last value. */
  reset(): void
}

/**
 * Create a keyed guard. An absent key's `shouldWrite` returns true (nothing
 * stamped yet), matching the old `map.get(key) === serialized` being false when
 * the key is missing.
 */
export function createKeyedEchoGuard<K>(): KeyedEchoGuard<K> {
  const map = new Map<K, string>()
  return {
    shouldWrite: (key, serialized) => map.get(key) !== serialized,
    stamp: (key, serialized) => {
      map.set(key, serialized)
    },
    reset: () => map.clear(),
  }
}
