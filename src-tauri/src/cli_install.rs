//! Self-contained `md` terminal-command installer, driven from the Settings
//! panel (VS Code's "install 'code' command in PATH" convention). Unlike the
//! dev-repo launcher (`scripts/md` + `scripts/mdCli.mjs`, installed by
//! `bun run install:cli`), this runs from the SHIPPED app: the installed
//! bundle has no repo and no Node, so it writes a PURE POSIX-sh shim that
//! hardcodes THIS binary's path and reimplements the launch routing in a
//! handful of lines. No user path is ever accepted — the commands only touch
//! the app's own `current_exe()` and a PATH directory — so they need no
//! allowlist involvement and no ACL entry beyond `core:default` (app commands
//! are always invokable).
//!
//! Routing mirrors `launch.rs::parse_launch_args`, the tested consumer on the
//! Rust side: a DIRECTORY becomes `--workspace <abs>` (launch.rs drops
//! positional directories, so a folder MUST go through the flag), a FILE is
//! passed positionally, and a nonexistent path errors to stderr with exit 2.
//! The shim launches the app in the BACKGROUND (`"$bin" "$@" &`) so a terminal
//! `md notes.md` returns the prompt promptly instead of blocking on the GUI
//! process — the same intent as `scripts/md`'s detached spawn.
//!
//! The toggle in the UI reflects FILESYSTEM TRUTH via `cli_status`, never a
//! stored preference: `installed` is true only when a `md` shim we wrote exists
//! AND still targets the current binary, so a stale shim left behind by a moved
//! app reads as not-installed (needs reinstall).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::history::atomic_write;

/// Preferred install directory when it exists and is writable without sudo.
const USR_LOCAL_BIN: &str = "/usr/local/bin";

/// What the frontend toggle renders. Snake_case rides through serde verbatim
/// (no rename), matching how `take_startup_workspace` returns `suppress_restore`
/// — the TS `CliStatus` reads `on_path` directly.
#[derive(Debug, PartialEq, Serialize)]
pub struct CliStatus {
    /// A `md` shim we wrote exists AND targets the current binary.
    pub installed: bool,
    /// Where the shim is (installed) or would be written (not installed).
    pub path: Option<String>,
    /// The shim's directory is a component of `$PATH`.
    pub on_path: bool,
}

/// Single-quote `s` for safe embedding in a POSIX-sh script: wrap in `'…'` and
/// rewrite each embedded `'` as `'\''`. App bundle paths never contain quotes,
/// but escaping keeps `shim_text` correct — and injection-proof — regardless.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Generate the pure POSIX-sh launcher shim, hardcoding `bin_path` (the app's
/// own `current_exe()`). Kept side-effect-free so the script text — and the
/// file/dir routing it encodes — is unit-testable and can be `sh -n`-checked
/// without writing into any PATH directory. See the module doc for the routing
/// contract and why the app is launched in the background.
pub fn shim_text(bin_path: &str) -> String {
    let bin = sh_single_quote(bin_path);
    // The rebuild idiom: shift each ORIGINAL arg off the front (bounded by the
    // saved count `n`) and append its processed form to the back of `$@`, so
    // after `n` rotations `$@` holds exactly the translated argument list.
    // Spaces survive because every expansion is quoted.
    format!(
        r#"#!/bin/sh
# Markdon `md` launcher — installed by the Markdon app's Settings panel.
# Do not edit by hand: reinstall from Settings if the app moves. Each argument
# is resolved to an absolute path and routed the way Markdon's launch parser
# expects — a directory as `--workspace <dir>`, a file positionally, a missing
# path as an error — then the app is launched in the background so the terminal
# returns immediately.
bin={bin}
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  case $arg in
    /*) abs=$arg ;;
    *) abs=$PWD/$arg ;;
  esac
  if [ -d "$abs" ]; then
    set -- "$@" --workspace "$abs"
  elif [ -e "$abs" ]; then
    set -- "$@" "$abs"
  else
    printf 'md: path does not exist: %s\n' "$arg" >&2
    exit 2
  fi
done
"$bin" "$@" &
exit 0
"#,
        bin = bin
    )
}

/// Pure target-dir choice: prefer `/usr/local/bin` when the probe reports it
/// usable (exists AND writable without sudo), else `~/.local/bin`.
fn choose_target_dir(usr_local_ok: bool, home_local_bin: PathBuf) -> PathBuf {
    if usr_local_ok {
        PathBuf::from(USR_LOCAL_BIN)
    } else {
        home_local_bin
    }
}

/// True when `dir` is a component of the `$PATH`-style string `path_var`.
/// Empty segments (a leading/trailing/`::` colon, meaning "cwd") never match a
/// real install dir.
fn dir_on_path(dir: &Path, path_var: &str) -> bool {
    path_var
        .split(':')
        .any(|seg| !seg.is_empty() && Path::new(seg) == dir)
}

/// A `md` shim we wrote is recognizable — and current — by the hardcoded
/// binary path inside it (see `shim_text`). A shim pointing at a DIFFERENT
/// (old) binary fails this check, so a moved app reads as not-installed.
fn shim_targets_bin(shim_contents: &str, bin_path: &str) -> bool {
    shim_contents.contains(bin_path)
}

/// `<dir>/md` as a lossy string — the shim's location for the UI.
fn md_path_string(dir: &Path) -> String {
    dir.join("md").to_string_lossy().into_owned()
}

/// Pure status assembly: `installed_dir` is `Some(dir)` when an existing `md`
/// shim targeting the current binary was found there; otherwise `target_dir`
/// is where an install would write. `path` and `on_path` describe whichever
/// directory applies.
fn derive_status(installed_dir: Option<PathBuf>, target_dir: PathBuf, path_var: &str) -> CliStatus {
    let installed = installed_dir.is_some();
    let dir = installed_dir.unwrap_or(target_dir);
    CliStatus {
        installed,
        on_path: dir_on_path(&dir, path_var),
        path: Some(md_path_string(&dir)),
    }
}

/// This process's own binary, as a UTF-8 string to hardcode into the shim.
fn current_bin() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "non-UTF-8 executable path".to_string())
}

/// `~/.local/bin` for this user.
fn home_local_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".local")
        .join("bin"))
}

/// Real writability probe for a candidate PATH dir: a temp file created and
/// dropped inside it proves both existence and no-sudo write access. A missing
/// or read-only dir fails, steering the caller to `~/.local/bin`.
fn dir_writable(dir: &Path) -> bool {
    tempfile::NamedTempFile::new_in(dir).is_ok()
}

/// The `md` shim path for each candidate dir, in preference order. Both are
/// probed for status (an existing shim in EITHER counts) and cleared on
/// uninstall.
fn candidate_dirs(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    Ok(vec![PathBuf::from(USR_LOCAL_BIN), home_local_bin(app)?])
}

/// The first candidate dir whose `md` shim exists AND targets `bin` — the
/// "installed" location, or `None` (including when only a stale shim exists).
fn find_installed_dir(dirs: &[PathBuf], bin: &str) -> Option<PathBuf> {
    dirs.iter().find_map(|dir| {
        let contents = fs::read_to_string(dir.join("md")).ok()?;
        shim_targets_bin(&contents, bin).then(|| dir.clone())
    })
}

/// FILESYSTEM-truth status of the `md` command (see module doc). Never reads a
/// stored preference: a shim counts only while it targets THIS binary.
#[tauri::command]
pub fn cli_status(app: AppHandle) -> Result<CliStatus, String> {
    let bin = current_bin()?;
    let dirs = candidate_dirs(&app)?;
    let installed_dir = find_installed_dir(&dirs, &bin);
    let target_dir = choose_target_dir(
        dir_writable(Path::new(USR_LOCAL_BIN)),
        home_local_bin(&app)?,
    );
    let path_var = std::env::var("PATH").unwrap_or_default();
    Ok(derive_status(installed_dir, target_dir, &path_var))
}

/// Write the self-contained `md` shim (chmod 0755) into the preferred writable
/// PATH dir, hardcoding this binary's path. Returns the fresh filesystem
/// status. Best-effort: any I/O failure surfaces as `Err(String)`.
#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<CliStatus, String> {
    let bin = current_bin()?;
    let target = choose_target_dir(
        dir_writable(Path::new(USR_LOCAL_BIN)),
        home_local_bin(&app)?,
    );
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let md = target.join("md");
    // atomic_write (tempfile + rename) leaves a fresh file at the tempfile's
    // 0600; a launcher must be executable, so chmod 0755 after the rename.
    atomic_write(&md, shim_text(&bin).as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&md, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    cli_status(app)
}

/// Remove the `md` shim from every candidate location, then report the new
/// status. Missing shims are not an error (uninstall is idempotent); only a
/// real removal failure surfaces.
#[tauri::command]
pub fn uninstall_cli(app: AppHandle) -> Result<CliStatus, String> {
    for dir in candidate_dirs(&app)? {
        let md = dir.join("md");
        match fs::remove_file(&md) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    cli_status(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- shim_text ------------------------------------------------------------

    #[test]
    fn shim_text_embeds_the_binary_path_and_is_a_sh_script() {
        let s = shim_text("/Applications/Markdon.app/Contents/MacOS/app");
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains("bin='/Applications/Markdon.app/Contents/MacOS/app'"));
    }

    #[test]
    fn shim_text_encodes_the_file_dir_missing_routing() {
        let s = shim_text("/bin/app");
        // Directory -> --workspace <abs>; file -> positional; missing -> exit 2.
        assert!(s.contains(r#"set -- "$@" --workspace "$abs""#));
        assert!(s.contains(r#"set -- "$@" "$abs""#));
        assert!(s.contains("exit 2"));
        // Launches in the background so the terminal returns promptly.
        assert!(s.contains(r#""$bin" "$@" &"#));
    }

    #[test]
    fn shim_text_single_quotes_escape_embedded_quotes() {
        // A pathological path with a single quote must not break out of the
        // quoted assignment.
        let s = shim_text("/weird/o'brien/app");
        assert!(s.contains(r#"bin='/weird/o'\''brien/app'"#));
    }

    // -- choose_target_dir ----------------------------------------------------

    #[test]
    fn choose_target_prefers_usr_local_when_writable() {
        let home = PathBuf::from("/home/u/.local/bin");
        assert_eq!(
            choose_target_dir(true, home.clone()),
            PathBuf::from(USR_LOCAL_BIN)
        );
    }

    #[test]
    fn choose_target_falls_back_to_home_when_not_writable() {
        let home = PathBuf::from("/home/u/.local/bin");
        assert_eq!(choose_target_dir(false, home.clone()), home);
    }

    // -- dir_on_path ----------------------------------------------------------

    #[test]
    fn dir_on_path_detects_a_component() {
        let dir = Path::new("/usr/local/bin");
        assert!(dir_on_path(dir, "/usr/bin:/usr/local/bin:/bin"));
        assert!(dir_on_path(dir, "/usr/local/bin"));
    }

    #[test]
    fn dir_on_path_rejects_a_missing_component_and_empty_segments() {
        let dir = Path::new("/home/u/.local/bin");
        assert!(!dir_on_path(dir, "/usr/bin:/bin"));
        // A stray `::` (cwd) segment must never be mistaken for the dir.
        assert!(!dir_on_path(Path::new(""), "/usr/bin::/bin"));
    }

    // -- shim_targets_bin -----------------------------------------------------

    #[test]
    fn shim_targets_bin_matches_the_current_binary_only() {
        let shim = shim_text("/Applications/Markdon.app/Contents/MacOS/app");
        assert!(shim_targets_bin(
            &shim,
            "/Applications/Markdon.app/Contents/MacOS/app"
        ));
        // A shim written for an old app location reads as not-current.
        assert!(!shim_targets_bin(
            &shim,
            "/old/Markdon.app/Contents/MacOS/app"
        ));
    }

    // -- derive_status --------------------------------------------------------

    #[test]
    fn derive_status_installed_reports_the_found_dir() {
        let st = derive_status(
            Some(PathBuf::from(USR_LOCAL_BIN)),
            PathBuf::from("/home/u/.local/bin"),
            "/usr/local/bin:/bin",
        );
        assert_eq!(
            st,
            CliStatus {
                installed: true,
                path: Some("/usr/local/bin/md".to_string()),
                on_path: true,
            }
        );
    }

    #[test]
    fn derive_status_not_installed_reports_the_target_dir_and_path_note_signal() {
        let st = derive_status(None, PathBuf::from("/home/u/.local/bin"), "/usr/bin:/bin");
        assert_eq!(
            st,
            CliStatus {
                installed: false,
                path: Some("/home/u/.local/bin/md".to_string()),
                // Not on PATH -> the UI shows the "add to PATH" note.
                on_path: false,
            }
        );
    }

    // -- find_installed_dir (fs, but into an injected temp dir only) ----------

    #[test]
    fn find_installed_dir_picks_a_current_shim_and_skips_a_stale_one() {
        let stale = tempfile::tempdir().unwrap();
        let good = tempfile::tempdir().unwrap();
        let bin = "/Applications/Markdon.app/Contents/MacOS/app";
        // A stale shim (old binary) in the first dir must not count.
        fs::write(stale.path().join("md"), shim_text("/old/app")).unwrap();
        fs::write(good.path().join("md"), shim_text(bin)).unwrap();
        let dirs = vec![stale.path().to_path_buf(), good.path().to_path_buf()];
        assert_eq!(
            find_installed_dir(&dirs, bin),
            Some(good.path().to_path_buf())
        );
    }

    #[test]
    fn find_installed_dir_is_none_when_only_a_stale_shim_exists() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("md"), shim_text("/old/app")).unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(
            find_installed_dir(&dirs, "/Applications/Markdon.app/Contents/MacOS/app"),
            None
        );
    }

    #[test]
    fn find_installed_dir_is_none_when_no_shim_exists() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(find_installed_dir(&dirs, "/bin/app"), None);
    }
}
