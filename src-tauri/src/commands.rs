use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{Manager, State};

use crate::allowlist::AllowedPaths;

/// Reject UNC and DOS device paths (Windows SSRF / NTLM-credential-theft vector).
/// Backslash-prefixed paths are never legitimate on unix, so they are rejected on
/// all platforms; forward-slash UNC and verbatim device prefixes matter on Windows.
pub(crate) fn reject_unsafe_path(path: &str) -> Result<(), String> {
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

/// Write via a temp file in the same directory + rename, so a crash or full disk
/// mid-write can never leave `path` truncated or half-written. Preserves the
/// existing file's permissions (a fresh temp file would otherwise be 0600).
fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents.as_bytes())?;
    if let Ok(meta) = fs::metadata(path) {
        fs::set_permissions(tmp.path(), meta.permissions())?;
    }
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

pub(crate) fn read_file_impl(path: &str) -> Result<String, String> {
    reject_unsafe_path(path)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub(crate) fn write_file_impl(path: &str, contents: &str) -> Result<(), String> {
    reject_unsafe_path(path)?;
    atomic_write(Path::new(path), contents).map_err(|e| e.to_string())
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
fn resolve_image_under(doc_parent: &Path, rel: &str) -> Result<PathBuf, String> {
    let parent = fs::canonicalize(doc_parent).map_err(|_| IMAGE_RESOLVE_ERR.to_string())?;
    let canon =
        fs::canonicalize(doc_parent.join(rel)).map_err(|_| IMAGE_RESOLVE_ERR.to_string())?;
    if canon.starts_with(&parent) && canon != parent {
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
    if let Err(e) = app.asset_protocol_scope().allow_file(&resolved) {
        log::warn!("could not allow resolved image in asset scope: {e}");
    }
    resolved
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "non-UTF-8 path".to_string())
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
