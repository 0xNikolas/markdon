import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

// ui.ts persists the split flag to localStorage, which node vitest lacks:
// stub it before the module loads (dynamic import below, after the stub).
const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => {
    stored.set(k, v)
  },
})

const {
  formatInt,
  lnColText,
  watchLabel,
  parseSplit,
  split,
  toggleSplit,
  exportTick,
  requestExport,
  fileBreadcrumb,
  isInsideRoot,
  windowTitle,
  emptyState,
  imageView,
  isGotoLineFallbackKey,
  isFindReplaceFallbackKey,
  isQuickOpenKey,
  fileCycleDirection,
  isReopenClosedKey,
} = await import('./ui')

describe('formatInt', () => {
  it('groups thousands with commas (en-US)', () => {
    expect(formatInt(1842)).toBe('1,842')
    expect(formatInt(1234567)).toBe('1,234,567')
  })

  it('leaves small numbers alone', () => {
    expect(formatInt(0)).toBe('0')
    expect(formatInt(284)).toBe('284')
  })
})

describe('lnColText', () => {
  it('is null when there is no cursor (Ln/Col segment hidden)', () => {
    expect(lnColText(null)).toBeNull()
  })

  it('prints line and col as-is (line 1-based, col 0-based)', () => {
    expect(lnColText({ line: 14, col: 42 })).toBe('Ln 14, Col 42')
    expect(lnColText({ line: 1, col: 0 })).toBe('Ln 1, Col 0')
  })
})

describe('watchLabel', () => {
  it('maps watch status to the status-bar label', () => {
    expect(watchLabel('watching')).toBe('Live')
    expect(watchLabel('idle')).toBe('Idle')
  })
})

describe('parseSplit', () => {
  it("only the persisted 'true' enables split", () => {
    expect(parseSplit('true')).toBe(true)
    expect(parseSplit('false')).toBe(false)
    expect(parseSplit(null)).toBe(false)
    expect(parseSplit('junk')).toBe(false)
  })
})

describe('split', () => {
  beforeEach(() => {
    split.set(false)
    stored.delete('markdon.split')
  })

  it('toggleSplit flips the store', () => {
    expect(get(split)).toBe(false)
    toggleSplit()
    expect(get(split)).toBe(true)
    toggleSplit()
    expect(get(split)).toBe(false)
  })

  it("persists each toggle under 'markdon.split'", () => {
    toggleSplit()
    expect(stored.get('markdon.split')).toBe('true')
    toggleSplit()
    expect(stored.get('markdon.split')).toBe('false')
  })
})

// Settings / Go to Line / History visibility moved to overlay.ts — their
// open/close behavior is asserted in overlay.test.ts (unified activeOverlay
// store with refuse-if-open semantics).

describe('fileBreadcrumb', () => {
  it('is just "Untitled" with no crumbs for a null path', () => {
    expect(fileBreadcrumb(null, null, null)).toEqual({ crumbs: [], filename: 'Untitled' })
    expect(fileBreadcrumb(null, '/ws/project', 'project')).toEqual({ crumbs: [], filename: 'Untitled' })
  })

  it('splits a workspace file into root name + intermediate folders + filename', () => {
    expect(fileBreadcrumb('/ws/project/sub/folders/filename.md', '/ws/project', 'project')).toEqual({
      crumbs: ['project', 'sub', 'folders'],
      filename: 'filename.md',
    })
  })

  it('has no intermediate crumbs for a file exactly at the workspace root', () => {
    expect(fileBreadcrumb('/ws/project/filename.md', '/ws/project', 'project')).toEqual({
      crumbs: ['project'],
      filename: 'filename.md',
    })
  })

  it('falls back to parent-folder + filename when there is no open workspace', () => {
    expect(fileBreadcrumb('/Users/nicu/notes/todo.md', null, null)).toEqual({
      crumbs: ['notes'],
      filename: 'todo.md',
    })
  })

  it('falls back to parent-folder + filename for a path outside the open workspace', () => {
    expect(fileBreadcrumb('/Users/nicu/other/todo.md', '/ws/project', 'project')).toEqual({
      crumbs: ['other'],
      filename: 'todo.md',
    })
  })

  it('does not treat a sibling directory sharing a name prefix as inside the workspace', () => {
    // /ws/proj is NOT an ancestor of /ws/project2 even though the string is a prefix.
    expect(fileBreadcrumb('/ws/project2/file.md', '/ws/proj', 'proj')).toEqual({
      crumbs: ['project2'],
      filename: 'file.md',
    })
  })

  it('has no crumbs for a top-level file with no parent folder in its path', () => {
    expect(fileBreadcrumb('todo.md', null, null)).toEqual({ crumbs: [], filename: 'todo.md' })
  })

  it('never leaks full ancestry when the workspace root has no path segments', () => {
    // Root '/' (or '') would make the ancestry check vacuously true; must fall
    // back to the parent-only form instead of exposing the whole path.
    expect(fileBreadcrumb('/Users/nicu/notes/secret.md', '/', 'Macintosh HD')).toEqual({
      crumbs: ['notes'],
      filename: 'secret.md',
    })
    expect(fileBreadcrumb('/Users/nicu/notes/secret.md', '', 'x')).toEqual({
      crumbs: ['notes'],
      filename: 'secret.md',
    })
  })
})

describe('windowTitle', () => {
  it('shows "Untitled" for a null path', () => {
    expect(windowTitle(null, false)).toBe('Untitled — Markdon')
  })

  it('shows the filename for a clean doc', () => {
    expect(windowTitle('/ws/notes/a.md', false)).toBe('a.md — Markdon')
  })

  it('prefixes a bullet while the doc is dirty', () => {
    expect(windowTitle('/ws/notes/a.md', true)).toBe('• a.md — Markdon')
    expect(windowTitle(null, true)).toBe('• Untitled — Markdon')
  })

  it('falls back safely on trailing-slash and segment-less paths', () => {
    // Mirrors fileBreadcrumb's segment filtering: empty segments never surface.
    expect(windowTitle('/ws/notes/', false)).toBe('notes — Markdon')
    expect(windowTitle('/', false)).toBe('Untitled — Markdon')
  })

  it('renders plain "Markdon" while the empty page is shown — empty wins over everything', () => {
    expect(windowTitle(null, false, true)).toBe('Markdon')
    // The empty page implies a pristine pathless doc, but stale-looking
    // inputs must not leak a filename or bullet either.
    expect(windowTitle('/ws/a.md', true, true)).toBe('Markdon')
  })
})

describe('emptyState', () => {
  it('starts false: a window is assumed to hold a document until told otherwise', () => {
    expect(get(emptyState)).toBe(false)
  })
})

describe('imageView', () => {
  it('starts null: no image is viewed until a tree image row is clicked', () => {
    expect(get(imageView)).toBeNull()
  })
})

describe('isInsideRoot', () => {
  it('is true for a file at or nested under the root', () => {
    expect(isInsideRoot('/ws/project/file.md', '/ws/project')).toBe(true)
    expect(isInsideRoot('/ws/project/sub/folders/file.md', '/ws/project')).toBe(true)
  })

  it('is false for a path outside the root', () => {
    expect(isInsideRoot('/Users/nicu/other/todo.md', '/ws/project')).toBe(false)
  })

  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    // /ws/proj is NOT an ancestor of /ws/project2 even though the string is a prefix.
    expect(isInsideRoot('/ws/project2/file.md', '/ws/proj')).toBe(false)
  })

  it('is false for a segment-less root (would otherwise vacuously match everything)', () => {
    expect(isInsideRoot('/Users/nicu/notes/secret.md', '/')).toBe(false)
    expect(isInsideRoot('/Users/nicu/notes/secret.md', '')).toBe(false)
  })
})

describe('isGotoLineFallbackKey', () => {
  it('ignores every key but L', () => {
    expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: false, key: 'k' }, true)).toBe(false)
    expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: false, key: 'k' }, false)).toBe(false)
  })

  it('is case-insensitive on the key', () => {
    expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: false, key: 'L' }, true)).toBe(true)
  })

  describe('on mac', () => {
    it('fires on metaKey alone', () => {
      expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: false, key: 'l' }, true)).toBe(true)
    })

    it('never fires with ctrlKey, even alongside metaKey (CM binds mac Ctrl-L to selectLine)', () => {
      expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: true, key: 'l' }, true)).toBe(false)
      expect(isGotoLineFallbackKey({ metaKey: false, ctrlKey: true, key: 'l' }, true)).toBe(false)
    })
  })

  describe('off mac', () => {
    it('fires on ctrlKey alone (CmdOrCtrl+L IS Ctrl+L there)', () => {
      expect(isGotoLineFallbackKey({ metaKey: false, ctrlKey: true, key: 'l' }, false)).toBe(true)
    })

    it('also fires on metaKey alone', () => {
      expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: false, key: 'l' }, false)).toBe(true)
    })

    it('fires with both held (no CM collision off mac -- selectLine binds Alt-L there)', () => {
      expect(isGotoLineFallbackKey({ metaKey: true, ctrlKey: true, key: 'l' }, false)).toBe(true)
    })
  })

  it('is false with neither modifier held', () => {
    expect(isGotoLineFallbackKey({ metaKey: false, ctrlKey: false, key: 'l' }, true)).toBe(false)
    expect(isGotoLineFallbackKey({ metaKey: false, ctrlKey: false, key: 'l' }, false)).toBe(false)
  })
})

describe('isFindReplaceFallbackKey', () => {
  it('requires altKey plus metaKey or ctrlKey, on KeyF', () => {
    expect(isFindReplaceFallbackKey({ metaKey: true, ctrlKey: false, altKey: true, code: 'KeyF' })).toBe(true)
    expect(isFindReplaceFallbackKey({ metaKey: false, ctrlKey: true, altKey: true, code: 'KeyF' })).toBe(true)
  })

  it('ignores every code but KeyF', () => {
    expect(isFindReplaceFallbackKey({ metaKey: true, ctrlKey: false, altKey: true, code: 'KeyG' })).toBe(false)
  })

  it('requires altKey (plain Cmd+F is find, not find-and-replace)', () => {
    expect(isFindReplaceFallbackKey({ metaKey: true, ctrlKey: false, altKey: false, code: 'KeyF' })).toBe(false)
  })

  it('requires metaKey or ctrlKey -- Alt+F alone does not fire', () => {
    expect(isFindReplaceFallbackKey({ metaKey: false, ctrlKey: false, altKey: true, code: 'KeyF' })).toBe(false)
  })

  it('checks e.code, not e.key -- macOS Option+F types the florin sign (ƒ), not "f"', () => {
    // Same physical KeyF regardless of what character Option produced.
    expect(
      isFindReplaceFallbackKey({ metaKey: true, ctrlKey: false, altKey: true, code: 'KeyF' }),
    ).toBe(true)
  })
})

describe('isQuickOpenKey', () => {
  const ev = (over: Partial<Parameters<typeof isQuickOpenKey>[0]>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'p',
    ...over,
  })

  it('ignores every key but P', () => {
    expect(isQuickOpenKey(ev({ metaKey: true, key: 'o' }), true)).toBe(false)
    expect(isQuickOpenKey(ev({ ctrlKey: true, key: 'o' }), false)).toBe(false)
  })

  it('is case-insensitive on the key', () => {
    expect(isQuickOpenKey(ev({ metaKey: true, key: 'P' }), true)).toBe(true)
  })

  it('requires Shift up — Cmd+Shift+P is reserved, never Quick Open', () => {
    expect(isQuickOpenKey(ev({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isQuickOpenKey(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
  })

  it('requires Alt up', () => {
    expect(isQuickOpenKey(ev({ metaKey: true, altKey: true }), true)).toBe(false)
    expect(isQuickOpenKey(ev({ ctrlKey: true, altKey: true }), false)).toBe(false)
  })

  describe('on mac', () => {
    it('fires on metaKey alone', () => {
      expect(isQuickOpenKey(ev({ metaKey: true }), true)).toBe(true)
    })

    it('never fires with ctrlKey, even alongside metaKey (CM binds mac Ctrl-P to cursorLineUp)', () => {
      expect(isQuickOpenKey(ev({ metaKey: true, ctrlKey: true }), true)).toBe(false)
      expect(isQuickOpenKey(ev({ ctrlKey: true }), true)).toBe(false)
    })
  })

  describe('off mac', () => {
    it('fires on ctrlKey alone (CmdOrCtrl+P IS Ctrl+P there)', () => {
      expect(isQuickOpenKey(ev({ ctrlKey: true }), false)).toBe(true)
    })

    it('also fires on metaKey alone', () => {
      expect(isQuickOpenKey(ev({ metaKey: true }), false)).toBe(true)
    })

    it('fires with both held (no CM collision off mac)', () => {
      expect(isQuickOpenKey(ev({ metaKey: true, ctrlKey: true }), false)).toBe(true)
    })
  })

  it('is false with neither modifier held', () => {
    expect(isQuickOpenKey(ev({}), true)).toBe(false)
    expect(isQuickOpenKey(ev({}), false)).toBe(false)
  })
})

describe('exportTick', () => {
  it('requestExport increments monotonically', () => {
    const start = get(exportTick)
    requestExport()
    expect(get(exportTick)).toBe(start + 1)
    requestExport()
    expect(get(exportTick)).toBe(start + 2)
  })
})

describe('fileCycleDirection', () => {
  const ev = (over: Partial<Parameters<typeof fileCycleDirection>[0]>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: '',
    code: '',
    ...over,
  })

  describe('Ctrl+Tab family (every platform)', () => {
    it('Ctrl+Tab is next, Ctrl+Shift+Tab is previous — mac and non-mac alike', () => {
      const tab = { ctrlKey: true, key: 'Tab' }
      expect(fileCycleDirection(ev(tab), true)).toBe(1)
      expect(fileCycleDirection(ev(tab), false)).toBe(1)
      expect(fileCycleDirection(ev({ ...tab, shiftKey: true }), true)).toBe(-1)
      expect(fileCycleDirection(ev({ ...tab, shiftKey: true }), false)).toBe(-1)
    })

    it('requires physical Ctrl — plain Tab and Cmd+Tab (the macOS app switcher) never fire', () => {
      expect(fileCycleDirection(ev({ key: 'Tab' }), true)).toBeNull()
      expect(fileCycleDirection(ev({ metaKey: true, key: 'Tab' }), true)).toBeNull()
    })

    it('requires Meta and Alt up alongside Ctrl (OS/browser chords must not leak in)', () => {
      expect(fileCycleDirection(ev({ ctrlKey: true, metaKey: true, key: 'Tab' }), true)).toBeNull()
      expect(fileCycleDirection(ev({ ctrlKey: true, altKey: true, key: 'Tab' }), false)).toBeNull()
    })
  })

  describe('bracket family', () => {
    const next = { shiftKey: true, code: 'BracketRight' }
    const prev = { shiftKey: true, code: 'BracketLeft' }

    it('mac: Cmd+Shift+] is next, Cmd+Shift+[ is previous', () => {
      expect(fileCycleDirection(ev({ ...next, metaKey: true }), true)).toBe(1)
      expect(fileCycleDirection(ev({ ...prev, metaKey: true }), true)).toBe(-1)
    })

    it('non-mac: Ctrl+Shift+] / Ctrl+Shift+[', () => {
      expect(fileCycleDirection(ev({ ...next, ctrlKey: true }), false)).toBe(1)
      expect(fileCycleDirection(ev({ ...prev, ctrlKey: true }), false)).toBe(-1)
    })

    it('mac carve-out: never fires with ctrlKey, even alongside metaKey', () => {
      expect(fileCycleDirection(ev({ ...next, metaKey: true, ctrlKey: true }), true)).toBeNull()
      expect(fileCycleDirection(ev({ ...next, ctrlKey: true }), true)).toBeNull()
    })

    it('requires Shift (checked on e.code, so the un-shifted bracket keys stay free)', () => {
      expect(
        fileCycleDirection(ev({ metaKey: true, code: 'BracketRight' }), true),
      ).toBeNull()
    })

    it('requires Alt up and some CmdOrCtrl modifier', () => {
      expect(fileCycleDirection(ev({ ...next, metaKey: true, altKey: true }), true)).toBeNull()
      expect(fileCycleDirection(ev(next), false)).toBeNull()
    })

    it('checks e.code, not e.key — Shift remaps the bracket characters', () => {
      expect(
        fileCycleDirection(ev({ ...next, metaKey: true, key: '}' }), true),
      ).toBe(1)
      expect(fileCycleDirection(ev({ metaKey: true, shiftKey: true, key: ']' }), true)).toBeNull()
    })
  })

  it('is null for unrelated keys', () => {
    expect(fileCycleDirection(ev({ metaKey: true, key: 'p', code: 'KeyP' }), true)).toBeNull()
    expect(fileCycleDirection(ev({ ctrlKey: true, key: 'f', code: 'KeyF' }), false)).toBeNull()
  })
})

describe('isReopenClosedKey', () => {
  const ev = (over: Partial<Parameters<typeof isReopenClosedKey>[0]>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: 'T',
    ...over,
  })

  it('mac: Cmd+Shift+T fires (Shift reports key "T"; lowercased)', () => {
    expect(isReopenClosedKey(ev({ metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(isReopenClosedKey(ev({ metaKey: true, shiftKey: true, key: 't' }), true)).toBe(true)
  })

  it('mac carve-out: never fires with ctrlKey, even alongside metaKey', () => {
    expect(isReopenClosedKey(ev({ ctrlKey: true, shiftKey: true }), true)).toBe(false)
    expect(isReopenClosedKey(ev({ metaKey: true, ctrlKey: true, shiftKey: true }), true)).toBe(
      false,
    )
  })

  it('off mac: Ctrl+Shift+T (or Meta) fires', () => {
    expect(isReopenClosedKey(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(isReopenClosedKey(ev({ metaKey: true, shiftKey: true }), false)).toBe(true)
  })

  it('requires Shift down and Alt up', () => {
    expect(isReopenClosedKey(ev({ metaKey: true }), true)).toBe(false)
    expect(isReopenClosedKey(ev({ metaKey: true, shiftKey: true, altKey: true }), true)).toBe(
      false,
    )
  })

  it('ignores other keys and a bare Shift+T', () => {
    expect(isReopenClosedKey(ev({ metaKey: true, shiftKey: true, key: 'Y' }), true)).toBe(false)
    expect(isReopenClosedKey(ev({ shiftKey: true }), true)).toBe(false)
  })
})
