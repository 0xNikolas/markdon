import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * This webview's window label (`main`, or a spawned `doc-N`). Wrapped so it is
 * safe under vitest/jsdom where the Tauri internals aren't injected — there we
 * fall back to `main`, matching the single-window default.
 */
export function currentLabel(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

/**
 * Fire-and-forget native title update for THIS window (each webview resolves
 * its own handle, so doc-N windows title themselves independently). Same
 * try/catch fallback as `currentLabel` for vitest/jsdom, and the rejection is
 * swallowed too — a failed title update is cosmetic.
 */
export function setWindowTitle(title: string): void {
  try {
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {})
  } catch {
    /* vitest/jsdom: no Tauri internals injected */
  }
}

/**
 * Payload shape of every MODE-B-routed event: the intended target's label,
 * plus whatever event-specific fields ride along (e.g. `menu:open_recent`'s
 * `root`). Exported so handler maps (appBoot's MenuEventMap) can type their
 * payload parameter.
 */
export interface Routed {
  target?: string | null
  [key: string]: unknown
}

/**
 * The pure filter behind `listenScoped`: deliver when the payload is untargeted
 * (no `target` — e.g. a broadcast, or an event predating MODE B) or when it
 * names this window's own label. Exported for unit tests — this predicate IS
 * the defensive insurance below, so it gets pinned by windowing.test.ts.
 */
export function isForWindow(target: string | null | undefined, label: string): boolean {
  return target == null || target === label
}

/**
 * `listen()` that additionally drops any delivery whose payload names a
 * different window's label. MODE B routes menu / close / opened / external-
 * change events via `emit_to(label)`, which SHOULD already scope delivery per-
 * webview — but each of those payloads also carries its `target` label and we
 * filter on it here, as defensive insurance against that scoping assumption.
 * Untargeted events (no `target`, e.g. a broadcast) pass through unchanged,
 * so single-window behavior is unaffected. The payload is passed through to
 * the handler for events that carry data beyond the routing label (most
 * handlers ignore it — a zero-arg handler remains assignable).
 */
export function listenScoped(
  event: string,
  handler: (payload: Routed | null) => void,
): Promise<UnlistenFn> {
  const label = currentLabel()
  return listen<Routed | null>(event, (e) => {
    if (!isForWindow(e.payload?.target, label)) return
    handler(e.payload)
  })
}
