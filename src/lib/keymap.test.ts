import { describe, it, expect } from 'vitest'
import {
  KEYMAP,
  matchKeydown,
  menuItemIds,
  settingsList,
  bindingById,
  type KeyEventLike,
} from './keymap'

// A neutral keydown event; each test overrides only the fields it exercises.
// Mirrors the shape ui.ts's predicates read (and the real DOM KeyboardEvent).
function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    code: '',
    ...over,
  }
}

describe('matchKeydown — each combo resolves to its intended id', () => {
  it('Cmd+P / Ctrl+P is Quick Open (mac vs non-mac)', () => {
    expect(matchKeydown(ev({ metaKey: true, key: 'p', code: 'KeyP' }), true)?.id).toBe('quick_open')
    expect(matchKeydown(ev({ ctrlKey: true, key: 'p', code: 'KeyP' }), false)?.id).toBe('quick_open')
  })

  it('Cmd+Shift+T is Reopen Closed File', () => {
    expect(matchKeydown(ev({ metaKey: true, shiftKey: true, key: 'T', code: 'KeyT' }), true)?.id).toBe(
      'reopen_closed',
    )
    expect(
      matchKeydown(ev({ ctrlKey: true, shiftKey: true, key: 'T', code: 'KeyT' }), false)?.id,
    ).toBe('reopen_closed')
  })

  it('Ctrl+Tab cycles next, Ctrl+Shift+Tab cycles prev (physical Ctrl, every platform)', () => {
    expect(matchKeydown(ev({ ctrlKey: true, key: 'Tab', code: 'Tab' }), true)?.id).toBe(
      'file_cycle_next',
    )
    expect(matchKeydown(ev({ ctrlKey: true, key: 'Tab', code: 'Tab' }), false)?.id).toBe(
      'file_cycle_next',
    )
    expect(
      matchKeydown(ev({ ctrlKey: true, shiftKey: true, key: 'Tab', code: 'Tab' }), true)?.id,
    ).toBe('file_cycle_prev')
  })

  it('Cmd+Shift+] is next, Cmd+Shift+[ is prev (by e.code, not the shifted glyph)', () => {
    expect(
      matchKeydown(ev({ metaKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), true)?.id,
    ).toBe('file_cycle_next')
    expect(
      matchKeydown(ev({ metaKey: true, shiftKey: true, key: '{', code: 'BracketLeft' }), true)?.id,
    ).toBe('file_cycle_prev')
  })

  it('Cmd+Alt+F resolves to find_replace, NOT find — the load-bearing order', () => {
    // On mac Option+F reports e.key 'ƒ'; on non-mac it reports 'f' and would
    // also satisfy find's looser test, so find_replace must be matched first.
    expect(matchKeydown(ev({ metaKey: true, altKey: true, key: 'ƒ', code: 'KeyF' }), true)?.id).toBe(
      'find_replace',
    )
    expect(
      matchKeydown(ev({ ctrlKey: true, altKey: true, key: 'f', code: 'KeyF' }), false)?.id,
    ).toBe('find_replace')
  })

  it('Cmd+F / Ctrl+F (no Alt) is find', () => {
    expect(matchKeydown(ev({ metaKey: true, key: 'f', code: 'KeyF' }), true)?.id).toBe('find')
    expect(matchKeydown(ev({ ctrlKey: true, key: 'f', code: 'KeyF' }), false)?.id).toBe('find')
  })

  it('find claims mac Ctrl+F too (no mac carve-out, unlike the CM-colliding combos)', () => {
    expect(matchKeydown(ev({ ctrlKey: true, key: 'f', code: 'KeyF' }), true)?.id).toBe('find')
  })

  it('Cmd+L / Ctrl+L is Go to Line, with the mac Ctrl carve-out', () => {
    expect(matchKeydown(ev({ metaKey: true, key: 'l', code: 'KeyL' }), true)?.id).toBe('goto_line')
    expect(matchKeydown(ev({ ctrlKey: true, key: 'l', code: 'KeyL' }), false)?.id).toBe('goto_line')
    // mac Ctrl+L (no meta) belongs to CodeMirror's selectLine, not Go to Line.
    expect(matchKeydown(ev({ ctrlKey: true, key: 'l', code: 'KeyL' }), true)).toBeNull()
  })

  it('returns null for unrelated / bare keys', () => {
    expect(matchKeydown(ev({ key: 'a', code: 'KeyA' }), true)).toBeNull()
    expect(matchKeydown(ev({ metaKey: true, key: 'k', code: 'KeyK' }), true)).toBeNull()
    expect(matchKeydown(ev({ key: 'Escape', code: 'Escape' }), true)).toBeNull()
  })
})

describe('matchKeydown — mac Ctrl carve-outs are preserved', () => {
  it('mac Ctrl+P (no meta) is NOT Quick Open — reserved for CM cursorLineUp', () => {
    expect(matchKeydown(ev({ ctrlKey: true, key: 'p', code: 'KeyP' }), true)).toBeNull()
  })

  it('mac Ctrl+Shift+T (no meta) is NOT Reopen — Cmd is required on mac', () => {
    expect(matchKeydown(ev({ ctrlKey: true, shiftKey: true, key: 'T', code: 'KeyT' }), true)).toBeNull()
  })

  it('mac Ctrl+Shift+] (no meta) does not cycle', () => {
    expect(
      matchKeydown(ev({ ctrlKey: true, shiftKey: true, key: '}', code: 'BracketRight' }), true),
    ).toBeNull()
  })

  it('Cmd+Shift+P (Shift down) is NOT Quick Open — reserved combo', () => {
    expect(matchKeydown(ev({ metaKey: true, shiftKey: true, key: 'P', code: 'KeyP' }), true)).toBeNull()
  })
})

describe('settingsList — the Settings > Shortcuts rows', () => {
  it('reproduces the exact 20 rows, in display order, with labels/keys/notes', () => {
    expect(settingsList()).toEqual([
      { label: 'New File', keys: ['Cmd', 'N'] },
      { label: 'Open…', keys: ['Cmd', 'O'] },
      { label: 'Quick Open…', keys: ['Cmd', 'P'] },
      {
        label: 'Next Open File',
        keys: ['Cmd', 'Shift', ']'],
        note: 'Cycles the Open Files strip in row order, wrapping. Ctrl+Tab also works.',
      },
      {
        label: 'Previous Open File',
        keys: ['Cmd', 'Shift', '['],
        note: 'Same cycle, backwards. Ctrl+Shift+Tab also works.',
      },
      {
        label: 'Reopen Closed File',
        keys: ['Cmd', 'Shift', 'T'],
        note: 'Restores the most recently closed Open Files entry at its old position.',
      },
      { label: 'Save', keys: ['Cmd', 'S'] },
      { label: 'Save As…', keys: ['Cmd', 'Shift', 'S'] },
      {
        label: 'Export…',
        keys: ['Cmd', 'Shift', 'E'],
        note: 'Exports the current format; PDF opens the macOS print dialog (Save as PDF).',
      },
      { label: 'Find', keys: ['Cmd', 'F'] },
      {
        label: 'Find and Replace…',
        keys: ['Cmd', 'Alt', 'F'],
        note: 'WYSIWYG opens the find bar with the replace row expanded; split mode uses the CodeMirror native panel.',
      },
      {
        label: 'Go to Line…',
        keys: ['Cmd', 'L'],
        note: 'Accepts a line, or line:col (col is 0-based, matching the status bar).',
      },
      {
        label: 'File History…',
        keys: ['Cmd', 'Shift', 'H'],
        note: 'View and revert to previous saved versions; revert loads as unsaved changes.',
      },
      { label: 'Settings', keys: ['Cmd', ','] },
      { label: 'Undo', keys: ['Cmd', 'Z'] },
      { label: 'Redo', keys: ['Cmd', 'Shift', 'Z'] },
      { label: 'Cut', keys: ['Cmd', 'X'] },
      { label: 'Copy', keys: ['Cmd', 'C'] },
      { label: 'Paste', keys: ['Cmd', 'V'] },
      { label: 'Select All', keys: ['Cmd', 'A'] },
    ])
  })
})

describe('menuItemIds — the table covers every menu:<id> the backend emits', () => {
  // Mirror of src-tauri/src/menu.rs (the app-defined MenuItemBuilder ids) plus
  // the Open Recent submenu, which emits the shared menu:open_recent event.
  const EXPECTED_MENU_IDS = [
    'new',
    'open',
    'open_folder',
    'open_recent',
    'quick_open',
    'save',
    'save_as',
    'toggle_readonly',
    'history',
    'export',
    'find',
    'goto_line',
    'find_replace',
    'settings',
    'close_tab',
    'close_window',
    'close_folder',
    'show_log',
  ]

  it('exactly matches menu.rs (no missing or extra ids)', () => {
    expect(menuItemIds().slice().sort()).toEqual(EXPECTED_MENU_IDS.slice().sort())
  })

  it('every menu id resolves to a keymap binding', () => {
    for (const id of menuItemIds()) expect(bindingById(id)).toBeDefined()
  })
})

describe('KEYMAP integrity', () => {
  it('every keyboard-matched entry declares a guard and a preventDefault mode', () => {
    for (const b of KEYMAP) {
      if (b.match) {
        expect(b.keydownGuard, `${b.id} guard`).toBeDefined()
        expect(b.preventDefault, `${b.id} preventDefault`).toBeDefined()
      }
    }
  })

  it('ids are unique', () => {
    const ids = KEYMAP.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the always-preventDefault claims are exactly Quick Open / Reopen / file cycle', () => {
    const always = KEYMAP.filter((b) => b.preventDefault === 'always').map((b) => b.id).sort()
    expect(always).toEqual(['file_cycle_next', 'file_cycle_prev', 'quick_open', 'reopen_closed'])
  })
})
