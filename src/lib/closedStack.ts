import { get, writable, type Writable } from 'svelte/store'
import { workspace } from './workspace'

/**
 * The per-window "recently closed" stack behind Reopen Closed File
 * (Cmd/Ctrl+Shift+T): every route that CLOSES an Open Files strip row — the
 * row's close button, Cmd+W, and the strip context menu's Close variants —
 * records the closed path here, and the shortcut pops entries back open.
 * Delete-detach deliberately never records (the file is gone; a reopen row
 * would be dead on arrival).
 *
 * Kept simple on purpose:
 * - `index` is the row's strip position at close time; reopen re-inserts the
 *   path PINNED at that index when it still fits, else appended (a closed
 *   preview row records the after-the-pinned-rows position and comes back
 *   pinned — the one-italic-slot preview semantics don't survive a close).
 * - Entries are NOT retargeted on rename/move: a stale path simply fails the
 *   caller's existence probe and is skipped silently (same outcome as a
 *   deleted file).
 * - Cleared whenever the workspace root changes (same rationale and
 *   subscription shape as fileOpsState): closed-tab paths are only meaningful
 *   in the workspace they were closed in.
 */

export interface ClosedEntry {
  path: string
  /** Strip row index at close time (preview row = after every pinned row). */
  index: number
}

/** Stack cap: the reopen history VS Code users actually reach back for. */
export const MAX_CLOSED = 20

/**
 * Push `entry`, newest last. Re-closing a path already in the stack replaces
 * its old entry (one slot per path — reopening twice for one file would be a
 * dead second pop), and the stack drops its OLDEST entries past MAX_CLOSED.
 */
export function pushClosed(stack: readonly ClosedEntry[], entry: ClosedEntry): ClosedEntry[] {
  const out = stack.filter((e) => e.path !== entry.path)
  out.push(entry)
  return out.slice(-MAX_CLOSED)
}

/** Split off the newest entry; null on an empty stack. */
export function popClosed(
  stack: readonly ClosedEntry[],
): { entry: ClosedEntry; rest: ClosedEntry[] } | null {
  if (stack.length === 0) return null
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

/** The window's recently-closed stack, newest last. */
export const closedStack: Writable<ClosedEntry[]> = writable([])

/** Record a strip-row close (see module doc for who calls this — and who must not). */
export function recordClosed(path: string, index: number): void {
  closedStack.update((s) => pushClosed(s, { path, index }))
}

/** Pop-and-return the newest closed entry; null when the stack is empty. */
export function takeClosed(): ClosedEntry | null {
  const popped = popClosed(get(closedStack))
  if (popped === null) return null
  closedStack.set(popped.rest)
  return popped.entry
}

export function clearClosed(): void {
  closedStack.set([])
}

// Clear the stack whenever the open workspace's root changes — including the
// first adopt — mirroring fileOpsState's subscription: closed-tab paths from
// the previous workspace must not reopen into the new one. A same-root update
// (refreshWorkspace re-walking the tree) keeps the stack.
let lastRoot: string | null = get(workspace).root
workspace.subscribe((s) => {
  if (s.root === lastRoot) return
  lastRoot = s.root
  clearClosed()
})
