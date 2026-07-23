//! Shared filesystem + state-layout primitives, factored out of the modules
//! that used to each carry their own copy.
//!
//! - The ONE atomic write-via-temp-file-then-rename core (`write_atomic`), so a
//!   crash or full disk mid-write can never leave a target truncated or
//!   half-written. Two public shims sit on it: [`atomic_write_string`] preserves
//!   an existing file's permissions (a fresh temp file would otherwise be 0600),
//!   while [`atomic_write_bytes`] does not — its callers only ever write
//!   app-owned files that never pre-exist, so there is nothing to preserve.
//! - The per-workspace state-directory keying: [`bucket_key`] (the hashed
//!   directory name for a canonical path) and [`workspace_state_dir`]
//!   (`<base>/workspace-state/<bucket_key(root)>`), the layout history.rs's
//!   buckets and workspace.rs's `ui.json` both live under.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Atomic write core: temp file in the same directory (parent, or `.` when the
/// path has none) + rename. When `preserve_perms` is set, the target's existing
/// permissions are copied onto the temp file BEFORE the durability barrier —
/// tolerant on a missing target (`if let Ok(meta)`) but propagating a real
/// `set_permissions` failure. `sync_all` runs BEFORE `persist` in every case so
/// the rename never publishes unflushed bytes; `persist` surfaces its inner
/// error (`e.error`).
fn write_atomic(path: &Path, bytes: &[u8], preserve_perms: bool) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    if preserve_perms {
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(tmp.path(), meta.permissions())?;
        }
    }
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Atomically write raw bytes to `path` (no permission preservation — the
/// callers write app-owned files that never pre-exist).
pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(path, bytes, false)
}

/// Atomically write `contents` to `path`, preserving the existing file's
/// permissions (a fresh temp file would otherwise land at 0600).
pub(crate) fn atomic_write_string(path: &Path, contents: &str) -> std::io::Result<()> {
    write_atomic(path, contents.as_bytes(), true)
}

/// Lowercase hex of the SHA-256 of `bytes`.
pub(crate) fn sha256hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Bucket directory name for a canonical absolute path: `sha256hex(path)`.
pub(crate) fn bucket_key(canonical: &str) -> String {
    sha256hex(canonical.as_bytes())
}

/// A workspace's state directory: `<base>/workspace-state/<bucket_key(root)>`.
/// `canonical_root` must already be canonical so symlink/alias variants of one
/// root collapse to a single directory. Both history buckets and `ui.json` live
/// under here.
pub(crate) fn workspace_state_dir(base: &Path, canonical_root: &str) -> PathBuf {
    base.join("workspace-state")
        .join(bucket_key(canonical_root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_bytes_round_trips_and_overwrites() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("x.bin");
        atomic_write_bytes(&f, b"first").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"first");
        atomic_write_bytes(&f, b"second").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"second");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_string_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let f = dir.path().join("note.md");
        atomic_write_string(&f, "first").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        atomic_write_string(&f, "second").unwrap();
        let mode = fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o644,
            "atomic replace must keep the target's permissions"
        );
        assert_eq!(fs::read_to_string(&f).unwrap(), "second");
    }

    #[test]
    fn bucket_key_is_deterministic_hex64() {
        let k = bucket_key("/Users/me/notes/a.md");
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(k, bucket_key("/Users/me/notes/a.md"));
        assert_ne!(k, bucket_key("/Users/me/notes/b.md"));
    }

    #[test]
    fn workspace_state_dir_keys_under_the_hashed_root() {
        let base = Path::new("/data");
        assert_eq!(
            workspace_state_dir(base, "/ws/notes"),
            base.join("workspace-state").join(bucket_key("/ws/notes"))
        );
    }
}
