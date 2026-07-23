/** Test hooks installed by ./tauriInternals.js, typed for the e2e specs. */
declare global {
  interface Window {
    __TAURI_IPC_CALLS__: { cmd: string; args: Record<string, unknown> }[]
    __TAURI_IPC_OVERRIDES__?: Record<string, unknown>
    __TAURI_IPC_ERRORS__?: Record<string, string>
    __TAURI_FS__?: Record<string, string>
    __TAURI_DIRS__?: string[]
    __TAURI_WORKSPACE_ROOT__?: string
    __TAURI_RECENT__?: string[]
    /** Per-workspace ui.json map: the v2 strip object, or a bare string seed
        (tolerated as a v1 lastFile → active only) — see tauriInternals.js. */
    __TAURI_WORKSPACE_UI__?: Record<
      string,
      string | { tabs: string[]; preview: string | null; active: string | null }
    >
    /** Clipboard spy installed by specs (navigator.clipboard.writeText override). */
    __COPIED__?: string | null
    __tauriEmit(event: string, payload?: unknown): void
  }
}

export {}
