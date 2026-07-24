import * as ipc from './ipc'
import { writable, type Writable } from 'svelte/store'
import { createEchoGuard } from './echoGuard'
import { themePref, type ThemePref } from './theme'

/**
 * Versioned preferences store. Source of truth is the Rust-owned per-app file
 * `app_config_dir()/settings.json` (load_prefs/save_prefs commands), shared by
 * every instance and window; localStorage key `markdon.settings.v1` is kept
 * only as a synchronous boot CACHE so theme/typography stamp before first
 * paint without a flash (initSettings runs pre-mount — see src/main.ts).
 * localStorage is per-bundle-id and thus shared across instances too, but
 * with no cross-process storage events it silently last-writer-wins; the file
 * plus focus-triggered re-reads is what makes instances converge.
 *
 * Owns theme (single writer of theme.ts's `themePref`
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
   * Where a newly opened file lands. 'tab' = MODE A, add to the sidebar's
   * Open Files list in this window (today's behavior). 'window' = MODE B,
   * spawn a second app window via `openInPreferredTarget` (files.ts) —
   * falling back to opening in-place only if the spawn itself fails.
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
 * Map a font-family id to its CSS stack. Reuses the existing `--font-ui`
 * sans stack token (theme/shell/header already use it) rather than
 * introducing a second, redundant token for the same value.
 */
export function fontStack(f: Settings['fontFamily']): string {
  if (f === 'geist-mono') return 'var(--font-mono)'
  if (f === 'geist') return 'var(--font-ui)'
  return 'system-ui, sans-serif'
}

export const settings: Writable<Settings> = writable({ ...DEFAULTS })

/** DOM/storage/IPC touchpoints injected so initSettings is testable under node vitest. */
export interface SettingsEnv {
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
  setVar: (name: string, value: string) => void
  setTheme: (theme: ThemePref) => void
  /** Read the shared settings file; `null` means it doesn't exist yet. */
  loadRemote: () => Promise<string | null>
  /** Atomically replace the shared settings file. */
  saveRemote: (json: string) => Promise<void>
  /** Subscribe to window-focus; returns the remover. */
  onFocus: (cb: () => void) => () => void
}

function realEnv(): SettingsEnv {
  return {
    storage: window.localStorage,
    setVar: (name, value) => document.documentElement.style.setProperty(name, value),
    setTheme: (theme) => themePref.set(theme),
    loadRemote: () => ipc.loadPrefs(),
    saveRemote: (json) => ipc.savePrefs(json),
    onFocus: (cb) => {
      window.addEventListener('focus', cb)
      return () => window.removeEventListener('focus', cb)
    },
  }
}

/**
 * Boot from the localStorage cache (synchronously, seeding theme from the
 * legacy `markdon.themePref` key when settings are absent, preserving the
 * pre-settings status-bar choice with zero flash), then subscribe: every
 * change stamps the three `--editor-*` vars, pushes theme one-way into
 * theme.ts's `themePref`, refreshes the cache, and persists to the shared
 * settings file. After boot, reconcile against that file: apply it if the
 * user hasn't edited meanwhile, or seed it on first run (which is the whole
 * localStorage->file migration). A window-focus re-read is what makes
 * multiple instances — and multiple windows of one instance — converge.
 *
 * Two guards from the shared-file design:
 * - echo: applying a remote value pre-stamps `lastPersisted` with the
 *   NORMALIZED serialization, so the resulting subscriber run never saves it
 *   back (formatting drift would otherwise cause write storms);
 * - stale overwrite: the async reconcile applies the remote value only while
 *   the store still equals the boot snapshot — a user edit in between was
 *   already persisted and wins.
 *
 * Re-entry-safe: calling this again tears down the previous call's
 * subscriber and focus listener before installing new ones, so the shared
 * module-level `settings` store never accumulates stacked subscribers
 * (mirrors theme.ts's initTheme). The teardown also deactivates any
 * still-in-flight loadRemote, so a late resolution can't apply into a
 * re-initialized store. Returns the teardown (unused in production, used by
 * tests to avoid cross-test leakage).
 */
let activeUnsubscribe: (() => void) | null = null

export function initSettings(env: SettingsEnv = realEnv()): () => void {
  activeUnsubscribe?.()

  let raw = env.storage.getItem(SETTINGS_KEY)
  if (raw === null) {
    const legacy = env.storage.getItem(LEGACY_THEME_KEY)
    if (legacy === 'light' || legacy === 'dark') raw = JSON.stringify({ ...DEFAULTS, theme: legacy })
  }
  const boot = parseSettings(raw)
  const bootRaw = JSON.stringify(boot)
  /** Normalized serialization of the store's current value. */
  let current = bootRaw
  /**
   * Last serialization persisted to (or applied FROM) the shared file; the
   * subscriber skips saveRemote when it matches. Seeded with bootRaw so the
   * initial subscriber run never pushes the possibly-stale cache over the
   * file before the reconcile below has read it.
   */
  const echoGuard = createEchoGuard(bootRaw)
  let active = true

  settings.set(boot)
  const unsubscribe = settings.subscribe((s) => {
    const serialized = JSON.stringify(s)
    current = serialized
    try {
      // Unconditional (even on a remote apply): keeps the boot cache fresh.
      env.storage.setItem(SETTINGS_KEY, serialized)
    } catch {
      /* quota/private mode */
    }
    env.setVar('--editor-font-family', fontStack(s.fontFamily))
    env.setVar('--editor-font-size', `${s.fontSize}px`)
    env.setVar('--editor-line-height', String(s.lineHeight))
    env.setTheme(s.theme) // themePref.set — theme.ts stamps data-theme + native titlebar
    if (!echoGuard.shouldWrite(serialized)) return // echo of a remote apply (or boot)
    echoGuard.stamp(serialized)
    // Best-effort: an IPC failure degrades to today's localStorage-only world.
    void env.saveRemote(serialized).catch(() => {})
  })

  const applyRemote = (remoteRaw: string) => {
    const normalized = JSON.stringify(parseSettings(remoteRaw))
    if (normalized === current) return
    echoGuard.stamp(normalized) // pre-stamp so the apply doesn't echo a save
    settings.set(parseSettings(remoteRaw))
  }

  // Reconcile the boot cache against the shared file.
  void env
    .loadRemote()
    .then((remote) => {
      if (!active) return
      if (remote === null) {
        // First run with no settings.json yet: seed it from the current
        // settings — this IS the localStorage migration (keys stay as cache).
        void env.saveRemote(current).catch(() => {})
        return
      }
      // A user edit since boot was already persisted by the subscriber and
      // must win over the possibly-older file content.
      if (current !== bootRaw) return
      applyRemote(remote)
    })
    .catch(() => {})

  const offFocus = env.onFocus(() => {
    const snapshot = current
    void env
      .loadRemote()
      .then((remote) => {
        if (!active || remote === null) return
        // A user edit while this load was in flight was already persisted
        // and must win over the possibly-older file content (same rule as
        // the boot reconcile above).
        if (current !== snapshot) return
        applyRemote(remote)
      })
      .catch(() => {})
  })

  const teardown = () => {
    active = false
    offFocus()
    unsubscribe()
    if (activeUnsubscribe === teardown) activeUnsubscribe = null
  }
  activeUnsubscribe = teardown
  return teardown
}

export function updateSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  settings.update((s) => ({ ...s, [key]: value }))
}
