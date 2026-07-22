/** Test hooks installed by ./tauriInternals.js, typed for the e2e specs. */
declare global {
  interface Window {
    __TAURI_IPC_CALLS__: { cmd: string; args: Record<string, unknown> }[]
    __TAURI_IPC_OVERRIDES__?: Record<string, unknown>
    __TAURI_FS__?: Record<string, string>
    __tauriEmit(event: string, payload?: unknown): void
  }
}

export {}
