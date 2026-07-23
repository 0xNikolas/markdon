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
//!
//! `/usr/local/bin` is writable without elevation on Intel Macs (Homebrew
//! chowns it), but NOT on Apple Silicon, where Homebrew lives in
//! `/opt/homebrew` and never touches it — it stays `root:wheel`. When the
//! writability probe fails, `install_cli` asks for ONE-TIME admin
//! authorization via `osascript ... with administrator privileges` (the same
//! pattern iTerm2/VS Code/Sublime Text use for their shell-command
//! installers) to land the shim there anyway. A cancelled or unavailable
//! prompt is not a hard failure: it falls back to `~/.local/bin`, same as
//! before, and the Settings hint (`cliInstall.ts::pathHint`) tells the user to
//! add that to PATH.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::SeExt;
use crate::fsutil::atomic_write_bytes;

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
        .se()?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "non-UTF-8 executable path".to_string())
}

/// `~/.local/bin` for this user.
fn home_local_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().home_dir().se()?.join(".local").join("bin"))
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

/// Write the self-contained `md` shim (chmod 0755) directly into `dir`, which
/// must already be writable by this process. Shared by the fast path (`dir`
/// probed writable) and the `~/.local/bin` fallback; the admin-escalated path
/// writes via `osascript` instead (see `install_via_admin`).
fn write_shim_to(dir: &Path, shim: &str) -> Result<(), String> {
    fs::create_dir_all(dir).se()?;
    let md = dir.join("md");
    // atomic_write_bytes (tempfile + rename) leaves a fresh file at the
    // tempfile's 0600; a launcher must be executable, so chmod 0755 after the
    // rename.
    atomic_write_bytes(&md, shim.as_bytes()).se()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&md, fs::Permissions::from_mode(0o755)).se()?;
    }
    Ok(())
}

/// Double-quote `s` for embedding as an AppleScript string literal (escaping
/// `\` and `"`). `s` here is always our own `sh_single_quote`-wrapped shell
/// command, built from a fixed literal and app-controlled paths only — never
/// user input — but this keeps the escaping correct regardless.
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Land the shim at `dir/md` via a ONE-TIME admin-authenticated copy, for when
/// `dir` (normally `/usr/local/bin`) isn't writable without elevation. Stages
/// the shim in a user-owned temp file first — the privileged command only
/// ever `cp`s and `chmod`s, it never receives shim CONTENT to interpret — then
/// asks `osascript` to move it into place `with administrator privileges`,
/// which surfaces the standard macOS auth dialog. Returns `Err` for both a
/// cancelled prompt and any other elevation failure; callers treat both the
/// same way, as "fall back to the per-user dir", never as a hard failure.
fn install_via_admin(shim: &str, dir: &Path) -> Result<(), String> {
    use std::io::Write as _;
    let mut tmp = tempfile::NamedTempFile::new().se()?;
    tmp.write_all(shim.as_bytes()).se()?;
    let tmp_path = tmp.into_temp_path();
    let tmp_str = tmp_path.to_str().ok_or("non-UTF-8 temp path")?;
    let dir_str = dir.to_str().ok_or("non-UTF-8 target dir")?;
    let md = dir.join("md");
    let md_str = md.to_str().ok_or("non-UTF-8 target path")?;

    let shell_cmd = format!(
        "/bin/mkdir -p {} && /bin/cp {} {} && /bin/chmod 0755 {}",
        sh_single_quote(dir_str),
        sh_single_quote(tmp_str),
        sh_single_quote(md_str),
        sh_single_quote(md_str),
    );
    let osa_script = format!(
        "do shell script {} with administrator privileges",
        applescript_quote(&shell_cmd)
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(osa_script)
        .status()
        .se()?;
    // tmp_path deletes itself on drop, whether or not the cp above ran.

    if status.success() {
        Ok(())
    } else {
        Err("administrator authorization was cancelled or failed".to_string())
    }
}

/// Land the `md` shim on `$PATH`, hardcoding this binary's path. Prefers
/// `/usr/local/bin` (writable directly, or via one-time admin authorization —
/// see the module doc); falls back to the always-writable `~/.local/bin` when
/// neither works, e.g. the auth prompt was cancelled. Returns the fresh
/// filesystem status. Best-effort: any I/O failure other than a cancelled
/// prompt surfaces as `Err(String)`.
#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<CliStatus, String> {
    let bin = current_bin()?;
    let shim = shim_text(&bin);
    let usr_local = Path::new(USR_LOCAL_BIN);

    let landed_in_usr_local = if dir_writable(usr_local) {
        write_shim_to(usr_local, &shim)?;
        true
    } else {
        install_via_admin(&shim, usr_local).is_ok()
    };
    if !landed_in_usr_local {
        write_shim_to(&home_local_bin(&app)?, &shim)?;
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

    // -- applescript_quote ------------------------------------------------------

    #[test]
    fn applescript_quote_wraps_in_double_quotes() {
        assert_eq!(applescript_quote("/bin/cp a b"), r#""/bin/cp a b""#);
    }

    #[test]
    fn applescript_quote_escapes_backslashes_and_double_quotes() {
        // Escaping backslashes FIRST matters: if done after quote-escaping, an
        // escaped quote's own backslash would get double-escaped.
        assert_eq!(applescript_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    // -- write_shim_to (fs, but into an injected temp dir only) ----------------

    #[test]
    fn write_shim_to_creates_an_executable_shim_with_the_given_content() {
        let dir = tempfile::tempdir().unwrap();
        write_shim_to(dir.path(), "#!/bin/sh\necho hi\n").unwrap();

        let md = dir.path().join("md");
        assert_eq!(fs::read_to_string(&md).unwrap(), "#!/bin/sh\necho hi\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&md).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
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
