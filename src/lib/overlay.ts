import { writable, get, type Writable } from 'svelte/store'

/**
 * Single source of truth for the app's mutually exclusive full-window
 * surfaces: the Settings modal, the Go to Line popover, the File History
 * modal, the Quick Open palette, and the unsaved-changes discard guard.
 * At most ONE is ever open.
 *
 * Mutual exclusion lives here, at the store, not re-asserted by hand at every
 * opener: openOverlay refuses (returns false, no-op) while one is already
 * open. That closes DEFECT A1 — the four independent boolean flags let a
 * second overlay open on top of a first (e.g. the Settings gear clicked while
 * Go to Line or File History was up), stacking two focusTrap instances; on
 * close, focusTrap's unconditional `inert` set/clear stripped inertness out
 * from under the still-open overlay. With one-at-a-time guaranteed here,
 * focusTrap needs no refcount.
 */
export type Overlay =
  | { kind: 'settings' }
  | { kind: 'goto' }
  | { kind: 'history' }
  | { kind: 'quickopen' }
  | {
      kind: 'discard'
      action: () => void
      /**
       * What the modal's Save button runs, resolving to whether everything it
       * was responsible for came back clean (continue) or not (keep the modal
       * up — no edits silently lost). Omitted = the default active-doc save()
       * behavior; overridden by cached-tab close (saveCachedBuffer) and
       * window close (saveAllDirty), whose dirty buffers live in the buffer
       * cache rather than the active doc.
       */
      save?: () => Promise<boolean>
    }
  | null

export const activeOverlay: Writable<Overlay> = writable(null)

/**
 * Open `o` iff nothing is open. Returns true when it took, false (and a no-op,
 * leaving the current overlay untouched — including its payload) when refused.
 * The boolean lets keyboard fallbacks gate their preventDefault on success.
 */
export function openOverlay(o: Exclude<Overlay, null>): boolean {
  if (get(activeOverlay) !== null) return false
  activeOverlay.set(o)
  return true
}

/** Close whatever is open. No-op when the store is already empty. */
export function closeOverlay(): void {
  activeOverlay.set(null)
}

/** True while any overlay is open — the one gate every opener shares. */
export function anyOverlayOpen(): boolean {
  return get(activeOverlay) !== null
}
