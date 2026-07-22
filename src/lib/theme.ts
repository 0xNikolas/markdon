import { writable, type Writable } from 'svelte/store'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'markdon.themePref'

/** Current preference. 'system' follows the OS; 'light'/'dark' are explicit. */
export const themePref: Writable<ThemePref> = writable('system')

/** What to actually render, given a preference and whether the OS is in dark mode. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

/** Advance the 3-state toggle: system -> light -> dark -> system. */
export function nextPref(pref: ThemePref): ThemePref {
  return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system'
}

/**
 * Rewrite Crepe's frame-dark sheet so it applies only under [data-theme='dark'],
 * and strip its font variables so editor-theme.css keeps control of fonts.
 * (frame-dark/style.css is a single `.milkdown { --vars }` rule -- a test imports
 * the real file and fails if a Crepe upgrade ever changes that shape.)
 */
export function scopeDarkCss(css: string): string {
  return css
    .replace(/--crepe-font-(?:title|default|code):[^;]*;/g, '') // [^;] spans newlines: multi-line font stacks are fully removed
    .replaceAll('.milkdown', ":root[data-theme='dark'] .milkdown") // (0,3,0) beats frame.css's .milkdown (0,1,0)
}

/** DOM/Tauri touchpoints injected so initTheme is testable under node vitest. */
export interface ThemeEnv {
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
  systemDark: {
    matches: boolean
    addEventListener(type: 'change', cb: () => void): void
    removeEventListener(type: 'change', cb: () => void): void
  }
  applyDom: (theme: Theme) => void
  applyNative: (theme: Theme | null) => Promise<void>
}

function realEnv(): ThemeEnv {
  return {
    storage: window.localStorage,
    systemDark: window.matchMedia('(prefers-color-scheme: dark)'),
    applyDom: (theme) => {
      document.documentElement.dataset.theme = theme
    },
    applyNative: async (theme) => {
      await getCurrentWindow().setTheme(theme)
    },
  }
}

/**
 * Wire the theme system up: load the stored preference (or 'system'), stamp
 * data-theme on <html>, sync the native titlebar, and keep both in sync with
 * the OS theme (while pref is 'system') and with toggleTheme(). Call once,
 * before mount(), so there's no light-chrome flash. Returns a teardown
 * function (unused in production, used by tests to avoid cross-test leakage).
 */
export function initTheme(env: ThemeEnv = realEnv()): () => void {
  const stored = env.storage.getItem(STORAGE_KEY)
  const initial: ThemePref = stored === 'light' || stored === 'dark' ? stored : 'system'

  let pref: ThemePref = initial
  const stamp = () => env.applyDom(resolveTheme(pref, env.systemDark.matches))
  const onSystemChange = () => {
    if (pref === 'system') stamp()
  }
  env.systemDark.addEventListener('change', onSystemChange)

  // Set the store to the loaded preference *before* subscribing: subscribe()
  // always fires immediately with the store's current value, so this ensures
  // that first firing already carries the loaded pref instead of the store's
  // default.
  themePref.set(initial)
  const unsubscribe = themePref.subscribe((p) => {
    pref = p
    env.storage.setItem(STORAGE_KEY, p)
    stamp()
    void env.applyNative(p === 'system' ? null : p) // macOS: app-wide, restyles titlebar AND webview media query
  })

  return () => {
    unsubscribe()
    env.systemDark.removeEventListener('change', onSystemChange)
  }
}

/** Advance the toggle (system -> light -> dark -> system). */
export function toggleTheme(): void {
  themePref.update(nextPref)
}
