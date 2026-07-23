// Frontend view of the `md` terminal-command installer (Settings > General).
//
// The toggle reflects FILESYSTEM TRUTH, not a stored preference: SettingsModal
// queries `cli_status` on open and after every install/uninstall, and this
// module only holds the wire type plus the pure status->hint derivation so it
// can be unit-tested without the modal. See src-tauri/src/cli_install.rs for
// the backend contract; field names are snake_case to match its serde output.

/** Mirror of the Rust `CliStatus` (serde, no rename). */
export interface CliStatus {
  /** A `md` shim we wrote exists AND targets the current binary. */
  installed: boolean
  /** Where the shim is (installed) or would be written (not installed). */
  path: string | null
  /** The shim's directory is a component of `$PATH`. */
  on_path: boolean
}

/**
 * The one-line "add to PATH" note, or null when none is needed. Shown whenever
 * the shim's directory is NOT on `$PATH` (so `md` wouldn't resolve as a bare
 * command) — the directory is derived by stripping the trailing `/md` from the
 * shim path. On PATH, or with no known path, there is nothing to advise.
 */
export function pathHint(status: CliStatus): string | null {
  if (status.on_path || !status.path) return null
  const dir = status.path.replace(/\/md$/, '')
  return `Add ${dir} to your PATH to use \`md\`.`
}
