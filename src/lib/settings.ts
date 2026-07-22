import { writable, type Writable } from 'svelte/store'
import { themePref, type ThemePref } from './theme'

/**
 * Versioned preferences store, persisted as JSON under localStorage key
 * `markdon.settings.v1`. Owns theme (single writer of theme.ts's `themePref`
 * after this feature — see initSettings), editor typography (stamped as
 * `--editor-*` CSS vars on <html>, consumed by both Crepe and the future
 * CodeMirror split pane), CodeMirror behavior opts (contract only until
 * split-preview lands), and the default export format.
 *
 * Settings-modal visibility lives in overlay.ts (the shell's mutually
 * exclusive activeOverlay store) — this module imports nothing from there to
 * avoid a cycle; the modal component wires the two together.
 */
export interface Settings {
  version: 1
  theme: ThemePref
  fontFamily: 'geist-mono' | 'geist' | 'system'
  fontSize: number // 12-18 int
  lineHeight: number // 1.4-1.8, 0.1 steps
  softWrap: boolean
  tabWidth: 2 | 4
  autoCloseBrackets: boolean
  exportFormat: 'html' | 'md' | 'pdf'
  /**
   * Where a newly opened file lands (task 21). 'tab' = MODE A, add to the
   * sidebar's Open Files list in this window (today's behavior). 'window' =
   * MODE B, spawn a second app window — Stage 2 only; until it lands,
   * `openInPreferredTarget` (files.ts) falls back to in-place for both
   * values, so the preference is safe to expose early.
   */
  openMode: 'tab' | 'window'
}

export type SettingKey = keyof Omit<Settings, 'version'>

export const SETTINGS_KEY = 'markdon.settings.v1'
const LEGACY_THEME_KEY = 'markdon.themePref'

export const DEFAULTS: Settings = {
  version: 1,
  theme: 'system',
  fontFamily: 'geist',
  fontSize: 14,
  lineHeight: 1.6,
  softWrap: true,
  tabWidth: 2,
  autoCloseBrackets: true,
  exportFormat: 'html',
  openMode: 'tab',
}

const clampFontSize = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(18, Math.max(12, Math.round(n))) : DEFAULTS.fontSize

const clampLineHeight = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n)
    ? Math.min(1.8, Math.max(1.4, Math.round(n * 10) / 10))
    : DEFAULTS.lineHeight

function pick<T>(v: unknown, allowed: readonly T[], dflt: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : dflt
}

/** Tolerant parse: garbage/partial input -> per-field defaults, unknown keys stripped. */
export function parseSettings(raw: string | null): Settings {
  let obj: unknown
  try {
    obj = raw === null ? null : JSON.parse(raw)
  } catch {
    obj = null
  }
  if (typeof obj !== 'object' || obj === null) return { ...DEFAULTS }
  const o = obj as Record<string, unknown>
  if (o.version !== 1) return { ...DEFAULTS } // future: switch(o.version) migrations

  return {
    version: 1,
    theme: pick(o.theme, ['system', 'light', 'dark'] as const, DEFAULTS.theme),
    fontFamily: pick(o.fontFamily, ['geist-mono', 'geist', 'system'] as const, DEFAULTS.fontFamily),
    fontSize: clampFontSize(o.fontSize),
    lineHeight: clampLineHeight(o.lineHeight),
    softWrap: typeof o.softWrap === 'boolean' ? o.softWrap : DEFAULTS.softWrap,
    tabWidth: pick(o.tabWidth, [2, 4] as const, DEFAULTS.tabWidth),
    autoCloseBrackets: typeof o.autoCloseBrackets === 'boolean' ? o.autoCloseBrackets : DEFAULTS.autoCloseBrackets,
    exportFormat: pick(o.exportFormat, ['html', 'md', 'pdf'] as const, DEFAULTS.exportFormat),
    openMode: pick(o.openMode, ['tab', 'window'] as const, DEFAULTS.openMode),
  }
}

/**
 * Map a font-family id to its CSS stack. Deviation from spec-settings.json:
 * the repo's existing sans stack token is `--font-ui` (theme/shell/header
 * already use it), not `--font-sans` as the spec names it — reality wins,
 * the value is identical either way.
 */
export function fontStack(f: Settings['fontFamily']): string {
  if (f === 'geist-mono') return 'var(--font-mono)'
  if (f === 'geist') return 'var(--font-ui)'
  return 'system-ui, sans-serif'
}

export const settings: Writable<Settings> = writable({ ...DEFAULTS })

/** DOM/storage touchpoints injected so initSettings is testable under node vitest. */
export interface SettingsEnv {
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
  setVar: (name: string, value: string) => void
  setTheme: (theme: ThemePref) => void
}

function realEnv(): SettingsEnv {
  return {
    storage: window.localStorage,
    setVar: (name, value) => document.documentElement.style.setProperty(name, value),
    setTheme: (theme) => themePref.set(theme),
  }
}

/**
 * Load + parse the persisted settings (seeding theme from the legacy
 * `markdon.themePref` key when settings are absent, preserving the
 * pre-settings status-bar choice with zero flash), then subscribe: every
 * change persists to storage, stamps the three `--editor-*` vars, and
 * pushes theme one-way into theme.ts's `themePref`.
 *
 * Re-entry-safe: calling this again unsubscribes the previous call's
 * listener before installing a new one, so the shared module-level
 * `settings` store never accumulates stacked subscribers (mirrors
 * theme.ts's initTheme). Returns a teardown function (unused in
 * production, used by tests to avoid cross-test leakage).
 */
let activeUnsubscribe: (() => void) | null = null

export function initSettings(env: SettingsEnv = realEnv()): () => void {
  activeUnsubscribe?.()

  let raw = env.storage.getItem(SETTINGS_KEY)
  if (raw === null) {
    const legacy = env.storage.getItem(LEGACY_THEME_KEY)
    if (legacy === 'light' || legacy === 'dark') raw = JSON.stringify({ ...DEFAULTS, theme: legacy })
  }
  settings.set(parseSettings(raw))
  const unsubscribe = settings.subscribe((s) => {
    try {
      env.storage.setItem(SETTINGS_KEY, JSON.stringify(s))
    } catch {
      /* quota/private mode */
    }
    env.setVar('--editor-font-family', fontStack(s.fontFamily))
    env.setVar('--editor-font-size', `${s.fontSize}px`)
    env.setVar('--editor-line-height', String(s.lineHeight))
    env.setTheme(s.theme) // themePref.set — theme.ts stamps data-theme + native titlebar
  })

  activeUnsubscribe = unsubscribe
  return () => {
    unsubscribe()
    if (activeUnsubscribe === unsubscribe) activeUnsubscribe = null
  }
}

export function updateSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  settings.update((s) => ({ ...s, [key]: value }))
}
