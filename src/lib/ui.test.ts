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
  settingsOpen,
  openSettings,
  closeSettings,
  exportTick,
  requestExport,
  fileBreadcrumb,
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

describe('settingsOpen', () => {
  it('openSettings/closeSettings set and clear the flag', () => {
    expect(get(settingsOpen)).toBe(false)
    openSettings()
    expect(get(settingsOpen)).toBe(true)
    closeSettings()
    expect(get(settingsOpen)).toBe(false)
  })
})

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
