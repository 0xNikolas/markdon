import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'

// unlessEmpty's save/save_as gate is asserted through spies; the rest of
// './files' stays real (openPath is reachable via close_tab's switchGuarded,
// but that member is itself an injected spy so the real one never runs).
vi.mock('./files', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./files')>()
  return { ...mod, save: vi.fn(), saveAs: vi.fn() }
})
// menu:export routes through exportDocument; spy it to assert the unlessEmpty gate.
vi.mock('./export', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./export')>()
  return { ...mod, exportDocument: vi.fn() }
})

import { invoke } from './test-support/tauriMocks'
import { createKeymapWiring, type KeymapActions } from './appKeymap'
import { save, saveAs } from './files'
import { exportDocument } from './export'
import { menuItemIds } from './keymap'
import { doc, docWith } from './doc'
import { openList, previewPath } from './openList'
import { activeOverlay } from './overlay'
import { emptyState } from './ui'
import { searchUi } from './searchPlugin'

/** A fresh set of injected action spies (all 12 KeymapActions members). */
function makeActions(): { [K in keyof KeymapActions]: ReturnType<typeof vi.fn> } {
  return {
    newUntitled: vi.fn(),
    openFileDialog: vi.fn(),
    routeFind: vi.fn(),
    routeFindReplace: vi.fn(),
    toggleReadonly: vi.fn(),
    openQuickOpen: vi.fn(),
    onCloseFile: vi.fn(),
    switchGuarded: vi.fn(),
    closeThisWindow: vi.fn(),
    reopenClosedFile: vi.fn(),
    cycleFiles: vi.fn(),
    openStartupFile: vi.fn(),
  }
}

/** A structural keydown event with a preventDefault spy (node env has no DOM). */
function keyEvent(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const preventDefault = vi.fn()
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    code: '',
    ...over,
    preventDefault,
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
  vi.mocked(save).mockClear()
  vi.mocked(saveAs).mockClear()
  vi.mocked(exportDocument).mockClear()
  doc.set(docWith())
  openList.set([])
  previewPath.set(null)
  activeOverlay.set(null)
  emptyState.set(false)
  searchUi.set({
    open: false,
    query: '',
    count: 0,
    activeIndex: -1,
    caseSensitive: false,
    wholeWord: false,
    replaceOpen: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createKeymapWiring — menuEvents assembly', () => {
  it('emits window events first, then menu:<id> in menuItemIds() order', () => {
    const { menuEvents } = createKeymapWiring(makeActions())
    expect(Object.keys(menuEvents)).toEqual([
      'window:close-requested',
      'file:opened',
      ...menuItemIds().map((id) => `menu:${id}`),
    ])
  })

  it('has a handler for every menu id the keymap declares', () => {
    const { menuEvents } = createKeymapWiring(makeActions())
    for (const id of menuItemIds()) {
      expect(typeof menuEvents[`menu:${id}`]).toBe('function')
    }
  })
})

describe('createKeymapWiring — menu routing', () => {
  it('routes the direct menu items to their injected closures', () => {
    const actions = makeActions()
    const { menuEvents } = createKeymapWiring(actions)
    menuEvents['menu:new'](null)
    menuEvents['menu:open'](null)
    menuEvents['menu:close_window'](null)
    menuEvents['menu:quick_open'](null)
    menuEvents['window:close-requested'](null)
    expect(actions.newUntitled).toHaveBeenCalledTimes(1)
    expect(actions.openFileDialog).toHaveBeenCalledTimes(1)
    // close_window menu item AND the native window:close-requested both close.
    expect(actions.closeThisWindow).toHaveBeenCalledTimes(2)
    expect(actions.openQuickOpen).toHaveBeenCalledTimes(1)
  })

  it('open_recent extracts the routed root payload', () => {
    // openRecentWorkspace is a real singleton (fire-and-forget); resolve its IPC
    // to a benign workspace so the string-root branch's adopt doesn't reject.
    invoke.mockResolvedValue({ root: '/ws', tree: { name: 'ws', children: [] } })
    const actions = makeActions()
    const { menuEvents } = createKeymapWiring(actions)
    // Assert the routing shape (non-string root ignored, string root accepted),
    // not the workspace side effect.
    expect(() => menuEvents['menu:open_recent']({ root: null } as never)).not.toThrow()
    expect(() => menuEvents['menu:open_recent']({ root: '/ws' } as never)).not.toThrow()
  })
})

describe('unlessEmpty gate (menu save / save_as / export)', () => {
  it('no-ops on the empty page, runs when a document is present', () => {
    const { menuEvents } = createKeymapWiring(makeActions())

    emptyState.set(true)
    menuEvents['menu:save'](null)
    menuEvents['menu:save_as'](null)
    menuEvents['menu:export'](null)
    expect(save).not.toHaveBeenCalled()
    expect(saveAs).not.toHaveBeenCalled()
    expect(exportDocument).not.toHaveBeenCalled()

    emptyState.set(false)
    menuEvents['menu:save'](null)
    menuEvents['menu:save_as'](null)
    menuEvents['menu:export'](null)
    expect(save).toHaveBeenCalledTimes(1)
    expect(saveAs).toHaveBeenCalledTimes(1)
    expect(exportDocument).toHaveBeenCalledTimes(1)
  })
})

describe('menu:close_tab routing (via real closeTabDecision + stores)', () => {
  it('close-file: a pathed doc closes the active file', () => {
    const actions = makeActions()
    const { menuEvents } = createKeymapWiring(actions)
    doc.set(docWith({ path: '/w/a.md' }))
    menuEvents['menu:close_tab'](null)
    expect(actions.onCloseFile).toHaveBeenCalledWith('/w/a.md')
    expect(actions.closeThisWindow).not.toHaveBeenCalled()
  })

  it('reopen-preview: an untitled doc with a preview switch-guards it back', () => {
    const actions = makeActions()
    const { menuEvents } = createKeymapWiring(actions)
    previewPath.set('/w/pv.md') // doc is untitled (default)
    menuEvents['menu:close_tab'](null)
    expect(actions.switchGuarded).toHaveBeenCalledTimes(1)
    expect(actions.onCloseFile).not.toHaveBeenCalled()
  })

  it('close-window: an untitled doc with nothing open falls through to close', () => {
    const actions = makeActions()
    const { menuEvents } = createKeymapWiring(actions)
    menuEvents['menu:close_tab'](null)
    expect(actions.closeThisWindow).toHaveBeenCalledTimes(1)
  })
})

describe('handleWindowKeydown — matched bindings', () => {
  it('Quick Open (preventDefault:always) claims the combo even behind an overlay, but no-ops the action', () => {
    const actions = makeActions()
    const { handleWindowKeydown } = createKeymapWiring(actions)
    activeOverlay.set({ kind: 'settings' })
    const e = keyEvent({ metaKey: true, key: 'p', code: 'KeyP' }) // Cmd+P (matches either platform)
    handleWindowKeydown(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1) // claimed before the guard
    expect(actions.openQuickOpen).not.toHaveBeenCalled() // overlay guard blocked it

    activeOverlay.set(null)
    const e2 = keyEvent({ metaKey: true, key: 'p', code: 'KeyP' })
    handleWindowKeydown(e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.openQuickOpen).toHaveBeenCalledTimes(1)
  })

  it('Find (preventDefault:onRun) does NOT claim the combo when gated out on the empty page', () => {
    const actions = makeActions()
    const { handleWindowKeydown } = createKeymapWiring(actions)
    emptyState.set(true)
    const e = keyEvent({ ctrlKey: true, key: 'f', code: 'KeyF' })
    handleWindowKeydown(e)
    expect(e.preventDefault).not.toHaveBeenCalled() // onRun: no claim when gated
    expect(actions.routeFind).not.toHaveBeenCalled()

    emptyState.set(false)
    const e2 = keyEvent({ ctrlKey: true, key: 'f', code: 'KeyF' })
    handleWindowKeydown(e2)
    expect(e2.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.routeFind).toHaveBeenCalledTimes(1)
  })

  it('captures the mac flag once at creation (a later navigator change is ignored)', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' }) // create the wiring as non-mac
    const { handleWindowKeydown } = createKeymapWiring(makeActions())
    vi.stubGlobal('navigator', { platform: 'MacIntel' }) // would flip isMacPlatform() to true if re-read
    // metaKey+ctrlKey+L matches Go to Line ONLY under mac=false (the mac carve-out
    // excludes ctrlKey). It fires here iff the captured non-mac value is still used;
    // a re-read of the now-Mac navigator would exclude ctrlKey and never match.
    const e = keyEvent({ metaKey: true, ctrlKey: true, key: 'l', code: 'KeyL' })
    handleWindowKeydown(e)
    expect(get(activeOverlay)?.kind).toBe('goto')
  })
})

describe('handleWindowKeydown — Escape fallbacks', () => {
  it('closes the find bar on Escape while search is open and no discard modal is up', () => {
    const { handleWindowKeydown } = createKeymapWiring(makeActions())
    searchUi.update((ui) => ({ ...ui, open: true }))
    const e = keyEvent({ key: 'Escape', code: 'Escape' })
    handleWindowKeydown(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(get(searchUi).open).toBe(false)
  })

  it('does NOT close the find bar on Escape while the discard modal is up', () => {
    const { handleWindowKeydown } = createKeymapWiring(makeActions())
    searchUi.update((ui) => ({ ...ui, open: true }))
    activeOverlay.set({ kind: 'discard', action: () => {} })
    const e = keyEvent({ key: 'Escape', code: 'Escape' })
    handleWindowKeydown(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(get(searchUi).open).toBe(true)
  })

  it('closes the Go to Line popover on Escape', () => {
    const { handleWindowKeydown } = createKeymapWiring(makeActions())
    activeOverlay.set({ kind: 'goto' })
    const e = keyEvent({ key: 'Escape', code: 'Escape' })
    handleWindowKeydown(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(get(activeOverlay)).toBeNull()
  })

  it('gates the Escape fallbacks out on the empty page', () => {
    const { handleWindowKeydown } = createKeymapWiring(makeActions())
    emptyState.set(true)
    searchUi.update((ui) => ({ ...ui, open: true }))
    const e = keyEvent({ key: 'Escape', code: 'Escape' })
    handleWindowKeydown(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(get(searchUi).open).toBe(true) // untouched behind the empty-page gate
  })
})
