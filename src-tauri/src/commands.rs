use std::fs;
use std::io::Write;
use std::path::Path;

use tauri::State;

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
