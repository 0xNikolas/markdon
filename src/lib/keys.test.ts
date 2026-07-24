import { describe, it, expect } from 'vitest'
import {
  cmdOrCtrl,
  isGotoLineFallbackKey,
  isFindReplaceFallbackKey,
  isQuickOpenKey,
  fileCycleDirection,
  isReopenClosedKey,
} from './keys'

describe('cmdOrCtrl', () => {
  it('non-mac: matches metaKey or ctrlKey', () => {
    expect(cmdOrCtrl({ metaKey: true, ctrlKey: false }, false)).toBe(true)
    expect(cmdOrCtrl({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(cmdOrCtrl({ metaKey: true, ctrlKey: true }, false)).toBe(true)
    expect(cmdOrCtrl({ metaKey: false, ctrlKey: false }, false)).toBe(false)
  })

  it('mac carve-out is ON by default: metaKey alone matches, ctrlKey excludes', () => {
    expect(cmdOrCtrl({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(cmdOrCtrl({ metaKey: true, ctrlKey: true }, true)).toBe(false)
    expect(cmdOrCtrl({ metaKey: false, ctrlKey: true }, true)).toBe(false)
  })

  it('macCtrlCarveOut: false restores the plain metaKey || ctrlKey match on mac', () => {
    expect(cmdOrCtrl({ metaKey: true, ctrlKey: true }, true, { macCtrlCarveOut: false })).toBe(true)
    expect(cmdOrCtrl({ metaKey: false, ctrlKey: true }, true, { macCtrlCarveOut: false })).toBe(true)
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
