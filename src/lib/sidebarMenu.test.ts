import { describe, it, expect } from 'vitest'
import {
  selectionForContextMenu,
  clampMenuPosition,
  isSelectionClearingTarget,
} from './sidebarMenu'

describe('selectionForContextMenu', () => {
  it('keeps a multi-selection when the target is already in it', () => {
    const sel = new Set(['/ws/a.md', '/ws/b.md'])
    expect(selectionForContextMenu(sel, '/ws/a.md')).toEqual(sel)
  })

  it('replaces the selection when the target is outside it', () => {
    const sel = new Set(['/ws/a.md', '/ws/b.md'])
    expect(selectionForContextMenu(sel, '/ws/c.md')).toEqual(new Set(['/ws/c.md']))
  })

  it('selects the target when nothing is selected', () => {
    expect(selectionForContextMenu(new Set(), '/ws/c.md')).toEqual(new Set(['/ws/c.md']))
  })

  it('returns a NEW set in the replace case (never mutates the input)', () => {
    const sel = new Set(['/ws/a.md'])
    const out = selectionForContextMenu(sel, '/ws/c.md')
    expect(out).not.toBe(sel)
    expect(sel).toEqual(new Set(['/ws/a.md']))
  })
})

describe('clampMenuPosition', () => {
  const menu = { w: 190, h: 340 }
  const viewport = { w: 1200, h: 800 }

  it('passes through a position that fits', () => {
    expect(clampMenuPosition(100, 100, menu, viewport)).toEqual({ x: 100, y: 100 })
  })

  it('clamps to the right edge', () => {
    expect(clampMenuPosition(1150, 100, menu, viewport)).toEqual({ x: 1010, y: 100 })
  })

  it('clamps to the bottom edge', () => {
    expect(clampMenuPosition(100, 700, menu, viewport)).toEqual({ x: 100, y: 460 })
  })

  it('clamps both axes at a corner', () => {
    expect(clampMenuPosition(1199, 799, menu, viewport)).toEqual({ x: 1010, y: 460 })
  })

  it('floors at 0 when the menu is larger than the viewport', () => {
    expect(clampMenuPosition(10, 10, { w: 500, h: 900 }, { w: 400, h: 700 })).toEqual({ x: 0, y: 0 })
  })
})

describe('isSelectionClearingTarget', () => {
  // Structural fakes: real Elements satisfy the shape via Element.closest. The
  // production selector is a group ('button, .rename-input'), so the fakes
  // match on the term they represent appearing anywhere in the selector.
  const insideButton = { closest: (sel: string) => (sel.includes('button') ? {} : null) }
  const insideRenameInput = {
    closest: (sel: string) => (sel.includes('.rename-input') ? {} : null),
  }
  const outsideButton = { closest: (_sel: string) => null }

  it('clears on targets with no button ancestor (empty tree area, panel padding)', () => {
    expect(isSelectionClearingTarget(outsideButton)).toBe(true)
  })

  it('does NOT clear inside any button (rows, header controls, menu items)', () => {
    expect(isSelectionClearingTarget(insideButton)).toBe(false)
  })

  it('does NOT clear inside the inline-rename input (a caret click must not wipe the selection)', () => {
    expect(isSelectionClearingTarget(insideRenameInput)).toBe(false)
  })

  it('does NOT clear for non-element targets (fail closed)', () => {
    expect(isSelectionClearingTarget(null)).toBe(false)
    expect(isSelectionClearingTarget(undefined)).toBe(false)
    expect(isSelectionClearingTarget({})).toBe(false)
  })
})
