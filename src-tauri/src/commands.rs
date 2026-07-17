use std::fs;

/// Reject UNC and DOS device paths (Windows SSRF / NTLM-credential-theft vector).
/// Backslash-prefixed paths are never legitimate on unix, so they are rejected on
/// all platforms; forward-slash UNC and verbatim device prefixes matter on Windows.
fn reject_unsafe_path(path: &str) -> Result<(), String> {
    if path.starts_with(r"\\") {
        return Err("Refusing UNC path".into());
    }
    #[cfg(windows)]
    if path.starts_with("//") || path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        return Err("Refusing UNC or device path".into());
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    reject_unsafe_path(&path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap().to_string();

        write_file(p.clone(), "# Hello".into()).unwrap();
        let got = read_file(p).unwrap();
        assert_eq!(got, "# Hello");
    }

    #[test]
    fn read_missing_file_returns_err() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.md");
        let res = read_file(missing.to_str().unwrap().to_string());
        assert!(res.is_err());
    }

    #[test]
    fn write_overwrites_existing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap().to_string();

        write_file(p.clone(), "first".into()).unwrap();
        write_file(p.clone(), "second".into()).unwrap();
        assert_eq!(read_file(p).unwrap(), "second");
    }

    #[test]
    fn read_file_rejects_unc_path() {
        let res = read_file(r"\\evil-server\share\x".to_string());
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("UNC"));
    }

    #[test]
    fn write_file_rejects_unc_path() {
        let res = write_file(r"\\evil-server\share\x".to_string(), "x".into());
        assert!(res.is_err());
    }
}
