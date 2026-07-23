use std::fs;
use std::path::{Path, PathBuf};

use tauri::{Manager, State};

use crate::allowlist::{contains, AllowedPaths};
use crate::error::{CmdResult, SeExt};

/// Reject UNC and DOS device paths (Windows SSRF / NTLM-credential-theft vector).
/// Backslash-prefixed paths are never legitimate on unix, so they are rejected on
/// all platforms; forward-slash UNC and verbatim device prefixes matter on Windows.
pub(crate) fn reject_unsafe_path(path: &str) -> CmdResult<()> {
    if path.starts_with(r"\\") {
        return Err("Refusing UNC path".into());
    }
    // Windows also treats a forward-slash prefix as UNC; backslash prefixes
    // (incl. `\\?\` / `\\.\` device paths) are already caught above on all platforms.
    #[cfg(windows)]
    if path.starts_with("//") {
        return Err("Refusing UNC path".into());
    }
    Ok(())
}

pub(crate) fn read_file_impl(path: &str) -> CmdResult<String> {
    reject_unsafe_path(path)?;
    fs::read_to_string(path).se()
}

pub(crate) fn write_file_impl(path: &str, contents: &str) -> CmdResult<()> {
    reject_unsafe_path(path)?;
    crate::fsutil::atomic_write_string(Path::new(path), contents).se()
}

const IMAGE_RESOLVE_ERR: &str = "image path does not resolve inside the document's directory";

/// Pure core of [`resolve_image_asset`]: resolve relative image ref `rel`
/// against the document's parent directory and prove the result stays inside
/// it. Canonicalize resolves `..` AND symlinks and errors on nonexistent
/// paths, so traversal escape, symlink escape, and probe-by-nonexistent-path
/// all fail closed — the same posture as `AllowedPaths`. An absolute `rel`
/// makes `join` discard the base entirely, which the containment check then
/// rejects unless it happens to land back inside the parent. The parent dir
/// itself never passes (`canon != parent`): a directory is not an image.
fn resolve_image_under(doc_parent: &Path, rel: &str) -> CmdResult<PathBuf> {
    let parent = fs::canonicalize(doc_parent).map_err(|_| IMAGE_RESOLVE_ERR.to_string())?;
    let canon =
        fs::canonicalize(doc_parent.join(rel)).map_err(|_| IMAGE_RESOLVE_ERR.to_string())?;
    if contains(&parent, &canon, false) {
        Ok(canon)
    } else {
        Err(IMAGE_RESOLVE_ERR.into())
    }
}

/// Resolve a doc-relative image reference (`img/x.png`) to an absolute path
/// and grant THAT ONE FILE display access via the asset protocol. Exists so a
/// single-file open only needs a non-recursive parent-directory asset grant:
/// subdirectory refs are granted per resolved file here instead of via a
/// recursive grant over the whole parent tree. `doc_path` must itself be a
/// granted document (`ensure`), so a compromised webview cannot use this
/// command to probe or expose arbitrary trees; `rel` must resolve strictly
/// inside the doc's directory (see [`resolve_image_under`]) — a `../` ref
/// fails here and the frontend falls back to the plain convertFileSrc URL,
/// which renders iff a recursive workspace grant already covers it. The
/// asset-scope grant is best-effort like every other display-channel grant:
/// failure only degrades rendering of this image.
#[tauri::command]
pub fn resolve_image_asset(
    doc_path: String,
    rel: String,
    app: tauri::AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    allowed.ensure(&doc_path)?;
    reject_unsafe_path(&rel)?;
    let parent = Path::new(&doc_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| IMAGE_RESOLVE_ERR.to_string())?;
    let resolved = resolve_image_under(parent, &rel)?;
    // Irrevocable for the process lifetime (FsScope has no un-allow — see
    // lib.rs allow_asset_dir); acceptable: single file, display channel only.
    crate::allow_asset_file(&app, &resolved);
    resolved
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "non-UTF-8 path".to_string())
}

/// Platform invocation for revealing `path` in the OS file manager: macOS
/// selects the file via `open -R`; Windows via `explorer /select,`; Linux
/// xdg-open has no select, so the containing directory is opened instead.
/// With `is_dir` (the fallback when the log file doesn't exist yet) the
/// directory itself is opened everywhere. Pure so each cfg branch is
/// unit-testable.
pub(crate) fn reveal_invocation(
    path: &Path,
    is_dir: bool,
) -> (&'static str, Vec<std::ffi::OsString>) {
    #[cfg(target_os = "macos")]
    {
        if is_dir {
            ("open", vec![path.as_os_str().to_os_string()])
        } else {
            ("open", vec!["-R".into(), path.as_os_str().to_os_string()])
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Explorer does its own command-line parsing (commas split fields), and
        // std's spawn would wrap any spaced argument in quotes WHOLE — turning
        // `/select,C:\Users\John Doe\…` into one quoted token Explorer no
        // longer recognizes as a switch. So quote ONLY the path (Windows paths
        // cannot contain `"`) and hand the argument to Explorer verbatim via
        // `raw_arg` — see the cfg(windows) spawn in `reveal_log_file`.
        let quoted = |p: &Path| {
            let mut arg = std::ffi::OsString::from("\"");
            arg.push(p.as_os_str());
            arg.push("\"");
            arg
        };
        if is_dir {
            ("explorer", vec![quoted(path)])
        } else {
            let mut arg = std::ffi::OsString::from("/select,");
            arg.push(quoted(path));
            ("explorer", vec![arg])
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = if is_dir {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        ("xdg-open", vec![dir.as_os_str().to_os_string()])
    }
}

/// Spawn a `reveal_invocation` file-manager command and reap it. Spawn+reap
/// pattern as in windows.rs: dropping the Child would leave a zombie until
/// waited on, so a throwaway thread reaps it. Windows: the arguments are
/// pre-quoted for Explorer's own parser (see `reveal_invocation`); `raw_arg`
/// bypasses std's whole-argument quoting, which would otherwise swallow the
/// `/select,` switch for spaced paths.
fn spawn_reveal(prog: &str, args: Vec<std::ffi::OsString>) -> CmdResult<()> {
    let mut cmd = std::process::Command::new(prog);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for arg in args {
            cmd.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    cmd.args(args);
    crate::process::spawn_detached(cmd)
}

/// Help > Show Log (and the error banner's "Details…" button): reveal the log
/// file THIS instance writes in the OS file manager. The filename comes from
/// the managed `LogFileName` — computed in `run()` from the same handed-off
/// branch that configured the log plugin, so a per-pid child reveals its own
/// markdon-<pid>.log, never the primary's. A missing file (fresh install /
/// rotated away) falls back to revealing the log directory rather than
/// erroring.
#[tauri::command]
pub fn reveal_log_file(
    app: tauri::AppHandle,
    name: State<'_, crate::LogFileName>,
) -> Result<(), String> {
    let dir = app.path().app_log_dir().se()?;
    let path = dir.join(&name.0);
    let (prog, args) = if path.exists() {
        reveal_invocation(&path, false)
    } else {
        reveal_invocation(&dir, true)
    };
    spawn_reveal(prog, args)
}

/// Reveal a document in the OS file manager — the Open Files strip's
/// context-menu "Reveal in Finder". Gated by the strict per-path allowlist
/// (`AllowedPaths::ensure`, NOT `ensure_root`): only a path the user actually
/// granted — a dialog pick, an OS open event, or a file inside a granted
/// workspace — can be revealed, so even a fully compromised webview cannot
/// use this command to probe or surface arbitrary filesystem locations.
/// Same platform invocation + spawn/reap as `reveal_log_file`.
#[tauri::command]
pub fn reveal_path(path: String, allowed: State<'_, AllowedPaths>) -> Result<(), String> {
    allowed.ensure(&path)?;
    let (prog, args) = reveal_invocation(Path::new(&path), false);
    spawn_reveal(prog, args)
}

#[tauri::command]
pub fn read_file(path: String, allowed: State<'_, AllowedPaths>) -> Result<String, String> {
    allowed.ensure(&path)?;
    read_file_impl(&path)
}

#[tauri::command]
pub fn write_file(
    path: String,
    contents: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<(), String> {
    allowed.ensure(&path)?;
    write_file_impl(&path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap();

        write_file_impl(p, "# Hello").unwrap();
        let got = read_file_impl(p).unwrap();
        assert_eq!(got, "# Hello");
    }

    #[test]
    fn read_missing_file_returns_err() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.md");
        let res = read_file_impl(missing.to_str().unwrap());
        assert!(res.is_err());
    }

    #[test]
    fn write_overwrites_existing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap();

        write_file_impl(p, "first").unwrap();
        write_file_impl(p, "second").unwrap();
        assert_eq!(read_file_impl(p).unwrap(), "second");
    }

    #[test]
    fn read_file_rejects_unc_path() {
        let res = read_file_impl(r"\\evil-server\share\x");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("UNC"));
    }

    #[test]
    fn write_file_rejects_unc_path() {
        let res = write_file_impl(r"\\evil-server\share\x", "x");
        assert!(res.is_err());
    }

    #[test]
    fn reject_unsafe_path_rejects_canonical_windows_verbatim_paths() {
        // Pins WHY watch_workspace must not apply this guard to Rust's own
        // canonicalize output: on Windows, canonical paths carry the `\\?\`
        // verbatim prefix, which this guard rejects wholesale. Commands that
        // receive a canonical root back from the webview must rely on
        // ensure_root's granted-set membership instead.
        assert!(reject_unsafe_path(r"\\?\C:\Users\me\notes").is_err());
    }

    // -- reveal_invocation ----------------------------------------------------

    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_invocation_selects_the_file_and_opens_the_dir_fallback() {
        let (prog, args) = reveal_invocation(Path::new("/logs/markdon.log"), false);
        assert_eq!(prog, "open");
        assert_eq!(args, vec!["-R", "/logs/markdon.log"]);
        let (prog, args) = reveal_invocation(Path::new("/logs"), true);
        assert_eq!(prog, "open");
        assert_eq!(args, vec!["/logs"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_invocation_selects_the_file_and_opens_the_dir_fallback() {
        // Only the PATH is quoted, never the `/select,` switch: the arguments
        // go to Explorer verbatim (raw_arg), and a whole-argument quote around
        // a spaced path would make Explorer drop the switch entirely.
        let (prog, args) = reveal_invocation(Path::new(r"C:\logs\markdon.log"), false);
        assert_eq!(prog, "explorer");
        assert_eq!(args, vec![r#"/select,"C:\logs\markdon.log""#]);
        let (prog, args) = reveal_invocation(Path::new(r"C:\logs"), true);
        assert_eq!(prog, "explorer");
        assert_eq!(args, vec![r#""C:\logs""#]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_invocation_quotes_a_spaced_profile_path() {
        // The common case that broke: a user profile containing a space.
        let (prog, args) =
            reveal_invocation(Path::new(r"C:\Users\John Doe\logs\markdon.log"), false);
        assert_eq!(prog, "explorer");
        assert_eq!(
            args,
            vec![r#"/select,"C:\Users\John Doe\logs\markdon.log""#]
        );
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn reveal_invocation_opens_the_containing_dir() {
        // xdg-open has no select flag: a file ref opens its parent directory.
        let (prog, args) = reveal_invocation(Path::new("/logs/markdon.log"), false);
        assert_eq!(prog, "xdg-open");
        assert_eq!(args, vec!["/logs"]);
        let (prog, args) = reveal_invocation(Path::new("/logs"), true);
        assert_eq!(prog, "xdg-open");
        assert_eq!(args, vec!["/logs"]);
    }

    // -- resolve_image_under --------------------------------------------------

    #[test]
    fn resolve_image_resolves_a_subdir_ref() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("img");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("x.png");
        fs::write(&f, "png").unwrap();
        let got = resolve_image_under(dir.path(), "img/x.png").unwrap();
        assert_eq!(got, fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn resolve_image_normalizes_dot_segments_that_stay_inside() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("img");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("x.png");
        fs::write(&f, "png").unwrap();
        let got = resolve_image_under(dir.path(), "./img/../img/x.png").unwrap();
        assert_eq!(got, fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn resolve_image_rejects_a_traversal_escape() {
        let parent = tempdir().unwrap();
        let docs = parent.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        let secret = parent.path().join("secret.png");
        fs::write(&secret, "png").unwrap();
        // The file exists, so only the containment check can reject it.
        let res = resolve_image_under(&docs, "../secret.png");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("does not resolve inside"));
    }

    #[test]
    fn resolve_image_rejects_an_absolute_ref_outside_the_parent() {
        let dir = tempdir().unwrap();
        let other = tempdir().unwrap();
        let f = other.path().join("x.png");
        fs::write(&f, "png").unwrap();
        // Path::join with an absolute rhs discards the base — containment
        // must still reject the out-of-tree result.
        assert!(resolve_image_under(dir.path(), f.to_str().unwrap()).is_err());
    }

    #[test]
    fn resolve_image_rejects_a_nonexistent_ref() {
        let dir = tempdir().unwrap();
        // canonicalize fails for a nonexistent path -> fail closed.
        assert!(resolve_image_under(dir.path(), "ghost.png").is_err());
    }

    #[test]
    fn resolve_image_rejects_the_parent_dir_itself() {
        let dir = tempdir().unwrap();
        assert!(resolve_image_under(dir.path(), ".").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_image_rejects_a_symlink_escaping_the_parent() {
        let parent = tempdir().unwrap();
        let docs = parent.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        let secret = parent.path().join("secret.png");
        fs::write(&secret, "png").unwrap();
        let link = docs.join("img.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        // canonicalize resolves the symlink out of the doc dir -> rejected.
        assert!(resolve_image_under(&docs, "img.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap();

        write_file_impl(p, "first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_file_impl(p, "second").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o644,
            "atomic replace must keep the target's permissions"
        );
        assert_eq!(read_file_impl(p).unwrap(), "second");
    }
}
