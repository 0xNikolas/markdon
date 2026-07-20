import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

import {
  parseSettings,
  fontStack,
  updateSetting,
  initSettings,
  settings,
  DEFAULTS,
  SETTINGS_KEY,
  type Settings,
} from './settings'

describe('parseSettings', () => {
  it('returns full defaults for null', () => {
    expect(parseSettings(null)).toEqual(DEFAULTS)
  })

  it('returns full defaults for garbage JSON', () => {
    expect(parseSettings('not json{{{')).toEqual(DEFAULTS)
  })

  it('returns full defaults for a non-object JSON value', () => {
    expect(parseSettings('42')).toEqual(DEFAULTS)
    expect(parseSettings('null')).toEqual(DEFAULTS)
    expect(parseSettings('"hi"')).toEqual(DEFAULTS)
  })

  it('keeps valid fields from a partial object and defaults the rest', () => {
    const raw = JSON.stringify({ version: 1, theme: 'dark', fontSize: 16 })
    expect(parseSettings(raw)).toEqual({ ...DEFAULTS, theme: 'dark', fontSize: 16 })
  })

  it('clamps and rounds fontSize into 12-18', () => {
    expect(parseSettings(JSON.stringify({ version: 1, fontSize: 11 })).fontSize).toBe(12)
    expect(parseSettings(JSON.stringify({ version: 1, fontSize: 19 })).fontSize).toBe(18)
    expect(parseSettings(JSON.stringify({ version: 1, fontSize: 14.6 })).fontSize).toBe(15)
  })

  it('clamps and snaps lineHeight into 1.4-1.8 at 0.1 steps', () => {
    expect(parseSettings(JSON.stringify({ version: 1, lineHeight: 1.0 })).lineHeight).toBe(1.4)
    expect(parseSettings(JSON.stringify({ version: 1, lineHeight: 2.0 })).lineHeight).toBe(1.8)
    expect(parseSettings(JSON.stringify({ version: 1, lineHeight: 1.55 })).lineHeight).toBe(1.6)
  })

  it('rejects a bad tabWidth enum value (no 8)', () => {
    expect(parseSettings(JSON.stringify({ version: 1, tabWidth: 8 })).tabWidth).toBe(DEFAULTS.tabWidth)
    expect(parseSettings(JSON.stringify({ version: 1, tabWidth: 3 })).tabWidth).toBe(DEFAULTS.tabWidth)
    expect(parseSettings(JSON.stringify({ version: 1, tabWidth: 4 })).tabWidth).toBe(4)
  })

  it('defaults bad theme/fontFamily/exportFormat strings', () => {
    const raw = JSON.stringify({ version: 1, theme: 'purple', fontFamily: 'comic-sans', exportFormat: 'pdf' })
    const parsed = parseSettings(raw)
    expect(parsed.theme).toBe(DEFAULTS.theme)
    expect(parsed.fontFamily).toBe(DEFAULTS.fontFamily)
    expect(parsed.exportFormat).toBe(DEFAULTS.exportFormat)
  })

  it('falls back to defaults when version is not 1 (migration stub)', () => {
    expect(parseSettings(JSON.stringify({ version: 2, theme: 'dark' }))).toEqual(DEFAULTS)
  })

  it('strips unknown keys from the parsed result', () => {
    const raw = JSON.stringify({ version: 1, bogus: 'nope', extra: 123 })
    const parsed = parseSettings(raw) as Settings & { bogus?: unknown; extra?: unknown }
    expect(parsed.bogus).toBeUndefined()
    expect(parsed.extra).toBeUndefined()
    expect(parsed).toEqual(DEFAULTS)
  })

  it('round-trips a full valid settings object', () => {
    const full: Settings = {
      version: 1,
      theme: 'light',
      fontFamily: 'geist-mono',
      fontSize: 16,
      lineHeight: 1.5,
      softWrap: false,
      tabWidth: 4,
      autoCloseBrackets: false,
      exportFormat: 'md',
    }
    expect(parseSettings(JSON.stringify(full))).toEqual(full)
  })
})

describe('fontStack', () => {
  it('maps geist-mono to the mono CSS var stack', () => {
    expect(fontStack('geist-mono')).toBe('var(--font-mono)')
  })
  it('maps geist to the sans/ui CSS var stack', () => {
    expect(fontStack('geist')).toBe('var(--font-ui)')
  })
  it('maps system to a bare system-ui stack', () => {
    expect(fontStack('system')).toBe('system-ui, sans-serif')
  })
})

function fakeEnv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    store,
    setVar: vi.fn(),
    setTheme: vi.fn(),
  }
}

beforeEach(() => {
  settings.set({ ...DEFAULTS })
})

describe('initSettings', () => {
  it('seeds defaults and stamps all three --editor-* vars on init', () => {
    const env = fakeEnv()
    initSettings(env)
    expect(get(settings)).toEqual(DEFAULTS)
    expect(env.setVar).toHaveBeenCalledWith('--editor-font-family', 'var(--font-ui)')
    expect(env.setVar).toHaveBeenCalledWith('--editor-font-size', '14px')
    expect(env.setVar).toHaveBeenCalledWith('--editor-line-height', '1.6')
    expect(env.setTheme).toHaveBeenCalledWith('system')
  })

  it('re-stamps vars and calls setTheme on updateSetting', () => {
    const env = fakeEnv()
    initSettings(env)
    env.setVar.mockClear()
    env.setTheme.mockClear()
    updateSetting('fontSize', 18)
    expect(env.setVar).toHaveBeenCalledWith('--editor-font-size', '18px')
    updateSetting('theme', 'dark')
    expect(env.setTheme).toHaveBeenCalledWith('dark')
  })

  it('persists settings JSON under SETTINGS_KEY on updateSetting', () => {
    const env = fakeEnv()
    initSettings(env)
    updateSetting('tabWidth', 4)
    const persisted = JSON.parse(env.store.get(SETTINGS_KEY)!)
    expect(persisted.tabWidth).toBe(4)
  })

  it('loads an existing settings.v1 value from storage', () => {
    const env = fakeEnv({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULTS, fontSize: 18 }) })
    initSettings(env)
    expect(get(settings).fontSize).toBe(18)
    expect(env.setVar).toHaveBeenCalledWith('--editor-font-size', '18px')
  })

  it('seeds theme from legacy markdon.themePref when settings key is absent', () => {
    const env = fakeEnv({ 'markdon.themePref': 'dark' })
    initSettings(env)
    expect(get(settings).theme).toBe('dark')
    const persisted = JSON.parse(env.store.get(SETTINGS_KEY)!)
    expect(persisted.theme).toBe('dark')
    expect(env.setTheme).toHaveBeenCalledWith('dark')
  })

  it('ignores legacy markdon.themePref when the settings key is already present', () => {
    const env = fakeEnv({
      [SETTINGS_KEY]: JSON.stringify(DEFAULTS),
      'markdon.themePref': 'dark',
    })
    initSettings(env)
    expect(get(settings).theme).toBe('system')
  })

  it('ignores a garbage legacy markdon.themePref value', () => {
    const env = fakeEnv({ 'markdon.themePref': 'nonsense' })
    initSettings(env)
    expect(get(settings).theme).toBe('system')
  })

  it('does not crash when storage.setItem throws (quota/private mode)', () => {
    const env = fakeEnv()
    env.storage.setItem = () => {
      throw new Error('quota exceeded')
    }
    expect(() => initSettings(env)).not.toThrow()
    expect(() => updateSetting('fontSize', 16)).not.toThrow()
  })
})
