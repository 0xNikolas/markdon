import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { activeOverlay, openOverlay, closeOverlay, anyOverlayOpen } from './overlay'

// The overlay store is the single source of truth for the app's mutually
// exclusive full-window surfaces (Settings, Go to Line, File History, Quick
// Open, the discard-changes guard). "One overlay at a time" is enforced here, at the
// store, by openOverlay refusing while one is already open — not re-asserted
// by hand at every call site (DEFECT A1: stacked focus traps / inert strip).

describe('overlay', () => {
  beforeEach(() => {
    closeOverlay()
  })

  it('opens when empty and reports the active overlay', () => {
    expect(get(activeOverlay)).toBe(null)
    expect(anyOverlayOpen()).toBe(false)
    expect(openOverlay({ kind: 'settings' })).toBe(true)
    expect(get(activeOverlay)).toEqual({ kind: 'settings' })
    expect(anyOverlayOpen()).toBe(true)
  })

  it('refuses a second open and leaves the first in place', () => {
    expect(openOverlay({ kind: 'settings' })).toBe(true)
    // A second opener (e.g. the Settings gear clicked while Go to Line is up)
    // is a silent no-op — the fix that stops two focus traps from stacking.
    expect(openOverlay({ kind: 'goto' })).toBe(false)
    expect(get(activeOverlay)).toEqual({ kind: 'settings' })
  })

  it('accepts the quickopen kind and holds it exclusively like any other', () => {
    expect(openOverlay({ kind: 'quickopen' })).toBe(true)
    expect(get(activeOverlay)).toEqual({ kind: 'quickopen' })
    // Nothing stacks on the palette…
    expect(openOverlay({ kind: 'goto' })).toBe(false)
    closeOverlay()
    // …and the palette can't stack on anything else.
    expect(openOverlay({ kind: 'settings' })).toBe(true)
    expect(openOverlay({ kind: 'quickopen' })).toBe(false)
  })

  it('closeOverlay clears the active overlay', () => {
    openOverlay({ kind: 'history' })
    closeOverlay()
    expect(get(activeOverlay)).toBe(null)
    expect(anyOverlayOpen()).toBe(false)
  })

  it('closeOverlay on an already-empty store is a no-op', () => {
    expect(get(activeOverlay)).toBe(null)
    closeOverlay()
    expect(get(activeOverlay)).toBe(null)
    expect(anyOverlayOpen()).toBe(false)
  })

  it("preserves the discard overlay's action payload across a refused open", () => {
    let ran = 0
    const action = () => {
      ran += 1
    }
    expect(openOverlay({ kind: 'discard', action })).toBe(true)
    // A menu accelerator firing while the guard modal is up must not clobber
    // the deferred action.
    expect(openOverlay({ kind: 'settings' })).toBe(false)
    const current = get(activeOverlay)
    expect(current?.kind).toBe('discard')
    if (current?.kind === 'discard') current.action()
    expect(ran).toBe(1)
  })
})
