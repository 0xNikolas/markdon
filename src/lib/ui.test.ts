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
  emptyState,
  imageView,
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
//
// fileBreadcrumb / windowTitle / isInsideRoot moved to paths.ts (tested in
// paths.test.ts); the keyboard-matcher predicates moved to keys.ts (tested in
// keys.test.ts).

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

describe('exportTick', () => {
  it('requestExport increments monotonically', () => {
    const start = get(exportTick)
    requestExport()
    expect(get(exportTick)).toBe(start + 1)
    requestExport()
    expect(get(exportTick)).toBe(start + 2)
  })
})
