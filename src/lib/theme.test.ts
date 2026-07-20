import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'
import frameDark from '@milkdown/crepe/theme/frame-dark.css?inline'

import {
  resolveTheme,
  nextPref,
  scopeDarkCss,
  initTheme,
  themePref,
  toggleTheme,
  type ThemePref,
} from './theme'

describe('resolveTheme', () => {
  it('follows systemDark when pref is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('ignores systemDark when pref is explicit', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('nextPref', () => {
  it('cycles system -> light -> dark -> system', () => {
    expect(nextPref('system')).toBe('light')
    expect(nextPref('light')).toBe('dark')
    expect(nextPref('dark')).toBe('system')
  })
})

describe('scopeDarkCss', () => {
  const scoped = scopeDarkCss(frameDark)

  it('scopes every .milkdown selector under the dark data-theme attribute', () => {
    expect(scoped).toContain(":root[data-theme='dark'] .milkdown")
    // No occurrence of `.milkdown` that isn't preceded by the scoping prefix.
    expect(scoped.match(/(?<!data-theme='dark'\] )\.milkdown/g)).toBeNull()
  })

  it('strips the font declarations so editor-theme.css stays authoritative', () => {
    expect(scoped).not.toContain('--crepe-font-title')
    expect(scoped).not.toContain('--crepe-font-default')
    expect(scoped).not.toContain('--crepe-font-code')
  })

  it('keeps the color and shadow declarations intact', () => {
    expect(scoped).toContain('--crepe-color-background: #1a1a1a')
    expect(scoped).toContain('--crepe-shadow-1:')
    expect(scoped).toContain('--crepe-shadow-2:')
  })
})

function fakeEnv(initialStored: string | null) {
  const store = new Map<string, string>()
  if (initialStored !== null) store.set('markdon.themePref', initialStored)
  const listeners: Array<() => void> = []
  const systemDark = {
    matches: false,
    addEventListener: (_type: 'change', cb: () => void) => void listeners.push(cb),
    removeEventListener: (_type: 'change', cb: () => void) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  return {
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    systemDark,
    applyDom: vi.fn(),
    applyNative: vi.fn(async () => {}),
    fireSystemChange: (matches: boolean) => {
      systemDark.matches = matches
      listeners.forEach((cb) => cb())
    },
  }
}

let teardown: (() => void) | null = null

beforeEach(() => {
  themePref.set('system')
})

afterEach(() => {
  teardown?.()
  teardown = null
})

describe('initTheme', () => {
  it('defaults to system when storage is empty', () => {
    const env = fakeEnv(null)
    teardown = initTheme(env)
    expect(get(themePref)).toBe('system')
    expect(env.applyDom).toHaveBeenCalledWith('light')
    expect(env.applyNative).toHaveBeenCalledWith(null)
  })

  it('defaults to system when storage holds garbage', () => {
    const env = fakeEnv('nonsense')
    teardown = initTheme(env)
    expect(get(themePref)).toBe('system')
  })

  it('loads a stored explicit preference', () => {
    const env = fakeEnv('dark')
    teardown = initTheme(env)
    expect(get(themePref)).toBe('dark')
    expect(env.applyDom).toHaveBeenCalledWith('dark')
    expect(env.applyNative).toHaveBeenCalledWith('dark')
  })

  it('toggleTheme persists and restamps', () => {
    const env = fakeEnv(null)
    teardown = initTheme(env)
    toggleTheme() // system -> light
    expect(get(themePref)).toBe('light')
    expect(env.storage.getItem('markdon.themePref')).toBe('light')
    expect(env.applyDom).toHaveBeenCalledWith('light')
    expect(env.applyNative).toHaveBeenCalledWith('light')
  })

  it('restamps on system theme change while pref is system', () => {
    const env = fakeEnv(null)
    teardown = initTheme(env)
    env.applyDom.mockClear()
    env.fireSystemChange(true)
    expect(env.applyDom).toHaveBeenCalledWith('dark')
  })

  it('ignores system theme change while pref is explicit', () => {
    const env = fakeEnv('dark')
    teardown = initTheme(env)
    env.applyDom.mockClear()
    env.fireSystemChange(true)
    expect(env.applyDom).not.toHaveBeenCalled()
  })

  it('unsubscribes cleanly, leaving no listeners firing', () => {
    const env = fakeEnv(null)
    teardown = initTheme(env)
    teardown()
    teardown = null
    env.applyDom.mockClear()
    toggleTheme()
    env.fireSystemChange(true)
    expect(env.applyDom).not.toHaveBeenCalled()
  })
})

// Type-level sanity: ThemePref is exactly the three preference strings.
const _pref: ThemePref = 'system'
void _pref
