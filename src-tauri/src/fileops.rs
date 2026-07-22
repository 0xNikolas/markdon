//! File-operation commands for the sidebar file explorer (new/rename/move/copy/
//! duplicate/delete). SECURITY MODEL: the webview's paths are never trusted, only
//! re-validated against the [`AllowedPaths`] allowlist on every call. Sources are
//! validated with `ensure` (must exist, strictly inside a granted root);
//! destination directories with `ensure_container` (the root itself or anything
//! inside it); and every new leaf name with [`valid_leaf_name`], which rejects
//! any name containing a path separator so the final `container.join(name)` can
//! never escape the proven-in-root container. Deletion routes ONLY through the
//! Trash (`trash::delete`) — a permanent unlink is never reachable from here.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::{Manager, State};

use crate::allowlist::AllowedPaths;

/// Reject anything that is not a single in-directory leaf. A name containing a
/// path separator (or `.`/`..`/NUL) is what a `../escape` rename/new-name would
/// need; forbidding it means `container.join(name)` stays inside the container
/// that `ensure_container`/`ensure` already proved is in-root.
fn valid_leaf_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("invalid name".into());
    }
    Ok(())
}

/// Build a duplicate name by inserting `" copy"` / `" copy N"` before the
/// extension. A leading dot (dotfile) is not treated as an extension separator.
/// Directories have no extension to preserve, so the suffix is always appended
/// at the end (`v1.2-release` -> `v1.2-release copy`, not `v1 copy.2-release`).
/// Pure so the suffixing rule is unit-testable without the filesystem.
fn dup_name(name: &str, n: usize, is_dir: bool) -> String {
    let suffix = if n == 1 {
        " copy".to_string()
    } else {
        format!(" copy {n}")
    };
    if is_dir {
        return format!("{name}{suffix}");
    }
    match name.rfind('.') {
        Some(idx) if idx > 0 => format!("{}{}{}", &name[..idx], suffix, &name[idx..]),
        _ => format!("{name}{suffix}"),
    }
}

/// First non-colliding duplicate name in `dir` (`note.md` -> `note copy.md`,
/// then `note copy 2.md`, ...; a directory always suffixes at the end).
fn unique_dup_name(dir: &Path, name: &str, is_dir: bool) -> String {
    for n in 1.. {
        let candidate = dup_name(name, n, is_dir);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("the collision counter is unbounded")
}

/// Recursively copy `src` to `dest`, skipping symlinks anywhere in the tree —
/// mirrors `workspace::walk`'s policy so a copy can never dereference a link that
/// escapes the workspace root. `src` is assumed already validated by the caller.
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        // Never copy a symlink (its target may point outside the root).
        return Ok(());
    }
    if ft.is_dir() {
        fs::create_dir(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let child_ft = entry.file_type().map_err(|e| e.to_string())?;
            if child_ft.is_symlink() {
                continue;
            }
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn path_to_string(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(str::to_string)
        .ok_or_else(|| "non-UTF-8 path".to_string())
}

/// Shared tail of every impl that produces a brand-new path: stringify it and
/// grant it so the follow-up open/read/write passes `ensure` immediately (a
/// brand-new path can't canonicalize-into-root until it exists, exactly like
/// the save dialog granting its exact pick).
fn grant(allowed: &AllowedPaths, target: &Path) -> Result<String, String> {
    let p = path_to_string(target)?;
    allowed.allow(&p);
    Ok(p)
}

/// Shared no-clobber gate: reject when `target` already exists.
fn reject_if_exists(target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err("a file or folder with that name already exists".into());
    }
    Ok(())
}

// -- impl functions (take &AllowedPaths so they are unit-testable) ------------

pub(crate) fn create_file_impl(
    allowed: &AllowedPaths,
    dir: &str,
    name: &str,
) -> Result<String, String> {
    let container = allowed.ensure_container(dir)?;
    valid_leaf_name(name)?;
    let target = container.join(name);
    reject_if_exists(&target)?;
    fs::File::create(&target).map_err(|e| e.to_string())?;
    grant(allowed, &target)
}

pub(crate) fn create_folder_impl(
    allowed: &AllowedPaths,
    dir: &str,
    name: &str,
) -> Result<String, String> {
    let container = allowed.ensure_container(dir)?;
    valid_leaf_name(name)?;
    let target = container.join(name);
    reject_if_exists(&target)?;
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    grant(allowed, &target)
}

pub(crate) fn rename_entry_impl(
    allowed: &AllowedPaths,
    path: &str,
    new_name: &str,
) -> Result<String, String> {
    allowed.ensure(path)?;
    valid_leaf_name(new_name)?;
    let src = Path::new(path);
    let dest = src.parent().ok_or("no parent")?.join(new_name);
    reject_if_exists(&dest)?;
    fs::rename(src, &dest).map_err(|e| e.to_string())?;
    grant(allowed, &dest)
}

pub(crate) fn move_entry_impl(
    allowed: &AllowedPaths,
    src: &str,
    dest_dir: &str,
) -> Result<String, String> {
    allowed.ensure(src)?;
    let dest_dir = allowed.ensure_container(dest_dir)?;
    let src_path = Path::new(src);
    let base = src_path.file_name().ok_or("no basename")?;
    // Reject moving a directory into itself or a descendant.
    let src_canon = fs::canonicalize(src_path).map_err(|_| "source vanished")?;
    if dest_dir == src_canon || dest_dir.starts_with(&src_canon) {
        return Err("cannot move a folder into itself".into());
    }
    let dest = dest_dir.join(base);
    reject_if_exists(&dest)?;
    fs::rename(src_path, &dest).map_err(|e| e.to_string())?;
    grant(allowed, &dest)
}

pub(crate) fn copy_entry_impl(
    allowed: &AllowedPaths,
    src: &str,
    dest_dir: &str,
) -> Result<String, String> {
    allowed.ensure(src)?;
    let dest_dir = allowed.ensure_container(dest_dir)?;
    let src_path = Path::new(src);
    if fs::symlink_metadata(src_path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("cannot copy a symlink".into());
    }
    let base = src_path.file_name().ok_or("no basename")?;
    let src_canon = fs::canonicalize(src_path).map_err(|_| "source vanished")?;
    // Copying a dir into its own descendant would recurse forever.
    if dest_dir.starts_with(&src_canon) {
        return Err("cannot copy a folder into itself".into());
    }
    let dest = dest_dir.join(base);
    reject_if_exists(&dest)?;
    copy_tree(src_path, &dest)?;
    grant(allowed, &dest)
}

pub(crate) fn duplicate_entry_impl(allowed: &AllowedPaths, path: &str) -> Result<String, String> {
    allowed.ensure(path)?;
    let src = Path::new(path);
    let file_type = fs::symlink_metadata(src)
        .map_err(|e| e.to_string())?
        .file_type();
    if file_type.is_symlink() {
        return Err("cannot duplicate a symlink".into());
    }
    let parent = src.parent().ok_or("no parent")?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("non-UTF-8 name")?;
    let dest = parent.join(unique_dup_name(parent, name, file_type.is_dir()));
    copy_tree(src, &dest)?;
    grant(allowed, &dest)
}

/// Validate EVERY path before trashing ANY, so one unauthorized path aborts the
/// whole batch with nothing moved (no partial trashing).
fn ensure_all(allowed: &AllowedPaths, paths: &[String]) -> Result<(), String> {
    for p in paths {
        allowed.ensure(p)?;
    }
    Ok(())
}

pub(crate) fn delete_entries_impl(allowed: &AllowedPaths, paths: &[String]) -> Result<(), String> {
    ensure_all(allowed, paths)?;
    for p in paths {
        // Trash, never a permanent unlink: recoverable from the macOS Trash.
        // trash::Error's Display prints its Debug form, which embeds the
        // absolute PathBuf — never surface that to the webview/IPC. Log the
        // real error server-side and return a fixed message instead.
        trash::delete(p).map_err(|e| {
            log::warn!("could not move {p} to Trash: {e}");
            "could not move item to Trash".to_string()
        })?;
    }
    Ok(())
}

// -- pasted images -------------------------------------------------------------

/// Extensions a pasted image may be written with. A closed allowlist (not a
/// blocklist): anything else -- svg with scripts, html, arbitrary binaries --
/// is rejected before a single byte touches disk.
const PASTED_IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Pure: the candidate filename for pasted image number `n` of document
/// `<stem>.md` -- `<stem>-pasted-<n>.<ext>`.
fn pasted_image_name(stem: &str, n: usize, ext: &str) -> String {
    format!("{stem}-pasted-{n}.{ext}")
}

/// Byte twin of commands.rs's `atomic_write` (temp file in the same dir +
/// rename), minus the permission-preserving step: the target never exists
/// (the collision loop guarantees it), so there is nothing to preserve.
fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Decode and write a pasted image next to `doc_path` as
/// `<doc-stem>-pasted-<n>.<ext>` (first free n >= 1). Returns the bare file
/// NAME (what the markdown link needs) plus the absolute path (what the
/// command wrapper feeds to the asset-protocol grant). `doc_path` goes
/// through the same `ensure` gate as read/write -- a webview can only anchor
/// a paste to a document it was already granted -- and the new file is
/// granted afterwards so future reads of it pass `ensure` too.
pub(crate) fn save_pasted_image_impl(
    allowed: &AllowedPaths,
    doc_path: &str,
    data_b64: &str,
    ext: &str,
) -> Result<(String, PathBuf), String> {
    allowed.ensure(doc_path)?;
    if !PASTED_IMAGE_EXTS.contains(&ext) {
        return Err("unsupported image type".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let doc = Path::new(doc_path);
    let dir = doc.parent().ok_or("no parent")?;
    let stem = doc
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("non-UTF-8 name")?;
    for n in 1.. {
        let name = pasted_image_name(stem, n, ext);
        let target = dir.join(&name);
        if target.exists() {
            continue;
        }
        atomic_write_bytes(&target, &bytes).map_err(|e| e.to_string())?;
        grant(allowed, &target)?;
        return Ok((name, target));
    }
    unreachable!("the collision counter is unbounded")
}

// -- tauri command wrappers ---------------------------------------------------

#[tauri::command]
pub fn create_file(
    dir: String,
    name: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    create_file_impl(allowed.inner(), &dir, &name)
}

#[tauri::command]
pub fn create_folder(
    dir: String,
    name: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    create_folder_impl(allowed.inner(), &dir, &name)
}

#[tauri::command]
pub fn rename_entry(
    path: String,
    new_name: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    rename_entry_impl(allowed.inner(), &path, &new_name)
}

#[tauri::command]
pub fn move_entry(
    src: String,
    dest_dir: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    move_entry_impl(allowed.inner(), &src, &dest_dir)
}

#[tauri::command]
pub fn copy_entry(
    src: String,
    dest_dir: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    copy_entry_impl(allowed.inner(), &src, &dest_dir)
}

#[tauri::command]
pub fn duplicate_entry(path: String, allowed: State<'_, AllowedPaths>) -> Result<String, String> {
    duplicate_entry_impl(allowed.inner(), &path)
}

#[tauri::command]
pub fn delete_entries(paths: Vec<String>, allowed: State<'_, AllowedPaths>) -> Result<(), String> {
    delete_entries_impl(allowed.inner(), &paths)
}

#[tauri::command]
pub fn save_pasted_image(
    doc_path: String,
    data_b64: String,
    ext: String,
    app: tauri::AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    let (name, abs) = save_pasted_image_impl(allowed.inner(), &doc_path, &data_b64, &ext)?;
    // Runtime asset-protocol grant so convertFileSrc URLs for this exact file
    // render in the webview (the config scope stays empty -- grants are issued
    // per pasted file here and per opened directory in the dialog/workspace
    // commands, so this one is redundant whenever the doc's parent dir is
    // already granted; kept as belt-and-braces). Best-effort: a failed grant
    // only degrades display of the (already written, already returned) image,
    // so it must not turn a successful save into an error.
    if let Err(e) = app.asset_protocol_scope().allow_file(&abs) {
        log::warn!("could not allow pasted image in asset scope: {e}");
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn granted() -> (tempfile::TempDir, AllowedPaths) {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        (dir, a)
    }

    // -- valid_leaf_name ------------------------------------------------------

    #[test]
    fn leaf_name_rejects_separators_and_dots() {
        assert!(valid_leaf_name("note.md").is_ok());
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "x\0y"] {
            assert!(valid_leaf_name(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    // -- dup_name -------------------------------------------------------------

    #[test]
    fn dup_name_inserts_before_extension() {
        assert_eq!(dup_name("note.md", 1, false), "note copy.md");
        assert_eq!(dup_name("note.md", 2, false), "note copy 2.md");
        assert_eq!(dup_name("photos", 1, false), "photos copy");
        assert_eq!(dup_name("archive.tar.gz", 1, false), "archive.tar copy.gz");
        // Leading dot is not an extension separator.
        assert_eq!(dup_name(".env", 1, false), ".env copy");
    }

    #[test]
    fn dup_name_always_appends_for_directories() {
        // A directory's dot is not an extension -- the suffix goes at the very
        // end, never spliced into the middle of the name.
        assert_eq!(dup_name("v1.2-release", 1, true), "v1.2-release copy");
        assert_eq!(dup_name("v1.2-release", 2, true), "v1.2-release copy 2");
        assert_eq!(dup_name("photos", 1, true), "photos copy");
    }

    // -- create ---------------------------------------------------------------

    #[test]
    fn create_file_creates_grants_and_rejects_clobber() {
        let (dir, a) = granted();
        let d = dir.path().to_str().unwrap();
        let p = create_file_impl(&a, d, "new.md").unwrap();
        assert!(Path::new(&p).is_file());
        // Granted for immediate read/write.
        assert!(a.ensure(&p).is_ok());
        // No clobber.
        assert!(create_file_impl(&a, d, "new.md").is_err());
    }

    #[test]
    fn create_folder_creates_a_directory() {
        let (dir, a) = granted();
        let p = create_folder_impl(&a, dir.path().to_str().unwrap(), "sub").unwrap();
        assert!(Path::new(&p).is_dir());
    }

    #[test]
    fn create_rejects_a_traversal_name() {
        let (dir, a) = granted();
        // The leaf-name gate stops `../escape` before any path join.
        assert!(create_file_impl(&a, dir.path().to_str().unwrap(), "../escape.md").is_err());
        // And nothing was written outside the root.
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
    }

    #[test]
    fn create_in_an_ungranted_dir_is_rejected() {
        let a = AllowedPaths::default();
        let other = tempdir().unwrap();
        assert!(create_file_impl(&a, other.path().to_str().unwrap(), "x.md").is_err());
    }

    // -- rename ---------------------------------------------------------------

    #[test]
    fn rename_moves_within_the_same_dir() {
        let (dir, a) = granted();
        let f = dir.path().join("old.md");
        fs::write(&f, "hi").unwrap();
        let p = rename_entry_impl(&a, f.to_str().unwrap(), "new.md").unwrap();
        assert!(!f.exists());
        assert!(Path::new(&p).is_file());
        assert_eq!(fs::read_to_string(&p).unwrap(), "hi");
    }

    #[test]
    fn rename_rejects_a_traversal_new_name() {
        let (dir, a) = granted();
        let f = dir.path().join("old.md");
        fs::write(&f, "hi").unwrap();
        // The canonical attack: rename the open file to `../evil.md`.
        assert!(rename_entry_impl(&a, f.to_str().unwrap(), "../evil.md").is_err());
        assert!(!dir.path().parent().unwrap().join("evil.md").exists());
        assert!(f.exists(), "source untouched on a rejected rename");
    }

    #[test]
    fn rename_rejects_clobber() {
        let (dir, a) = granted();
        let f = dir.path().join("a.md");
        fs::write(&f, "a").unwrap();
        fs::write(dir.path().join("b.md"), "b").unwrap();
        assert!(rename_entry_impl(&a, f.to_str().unwrap(), "b.md").is_err());
    }

    #[test]
    fn rename_of_an_unauthorized_source_is_rejected() {
        let a = AllowedPaths::default();
        let other = tempdir().unwrap();
        let f = other.path().join("x.md");
        fs::write(&f, "x").unwrap();
        assert!(rename_entry_impl(&a, f.to_str().unwrap(), "y.md").is_err());
    }

    // -- move -----------------------------------------------------------------

    #[test]
    fn move_relocates_across_dirs() {
        let (dir, a) = granted();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let p = move_entry_impl(&a, f.to_str().unwrap(), sub.to_str().unwrap()).unwrap();
        assert!(!f.exists());
        // dest_dir is canonicalized by ensure_container, so the returned path is
        // the canonical form of sub/note.md.
        assert_eq!(
            Path::new(&p),
            fs::canonicalize(&sub).unwrap().join("note.md")
        );
        assert_eq!(fs::read_to_string(&p).unwrap(), "x");
    }

    #[test]
    fn move_to_a_dir_outside_root_is_rejected() {
        let (dir, a) = granted();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let outside = tempdir().unwrap();
        assert!(
            move_entry_impl(&a, f.to_str().unwrap(), outside.path().to_str().unwrap()).is_err()
        );
        assert!(f.exists(), "source untouched on a rejected move");
    }

    #[test]
    fn move_via_traversal_destination_is_rejected() {
        let (dir, a) = granted();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let escape = dir.path().join("..");
        assert!(move_entry_impl(&a, f.to_str().unwrap(), escape.to_str().unwrap()).is_err());
    }

    #[test]
    fn move_a_folder_into_its_own_descendant_is_rejected() {
        let (dir, a) = granted();
        let parent = dir.path().join("parent");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        assert!(move_entry_impl(&a, parent.to_str().unwrap(), child.to_str().unwrap()).is_err());
        assert!(parent.exists());
    }

    // -- copy -----------------------------------------------------------------

    #[test]
    fn copy_recursively_copies_a_folder() {
        let (dir, a) = granted();
        let srcdir = dir.path().join("src");
        fs::create_dir_all(srcdir.join("nested")).unwrap();
        fs::write(srcdir.join("a.md"), "a").unwrap();
        fs::write(srcdir.join("nested").join("b.md"), "b").unwrap();
        let destdir = dir.path().join("dest");
        fs::create_dir(&destdir).unwrap();
        let p = copy_entry_impl(&a, srcdir.to_str().unwrap(), destdir.to_str().unwrap()).unwrap();
        let copied = Path::new(&p);
        assert!(copied.join("a.md").is_file());
        assert_eq!(
            fs::read_to_string(copied.join("nested").join("b.md")).unwrap(),
            "b"
        );
        assert!(srcdir.exists(), "copy leaves the source in place");
    }

    #[cfg(unix)]
    #[test]
    fn copy_skips_symlinks_inside_the_tree() {
        let (dir, a) = granted();
        let srcdir = dir.path().join("src");
        fs::create_dir(&srcdir).unwrap();
        fs::write(srcdir.join("real.md"), "r").unwrap();
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret");
        fs::write(&secret, "top secret").unwrap();
        std::os::unix::fs::symlink(&secret, srcdir.join("link.md")).unwrap();
        let destdir = dir.path().join("dest");
        fs::create_dir(&destdir).unwrap();
        let p = copy_entry_impl(&a, srcdir.to_str().unwrap(), destdir.to_str().unwrap()).unwrap();
        let copied = Path::new(&p);
        assert!(copied.join("real.md").is_file());
        // The symlink was skipped, so no path pointing outside root was copied.
        assert!(!copied.join("link.md").exists());
    }

    #[test]
    fn copy_to_a_dir_outside_root_is_rejected() {
        let (dir, a) = granted();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let outside = tempdir().unwrap();
        assert!(
            copy_entry_impl(&a, f.to_str().unwrap(), outside.path().to_str().unwrap()).is_err()
        );
    }

    #[test]
    fn copy_rejects_clobber() {
        let (dir, a) = granted();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("note.md"), "existing").unwrap();
        assert!(copy_entry_impl(&a, f.to_str().unwrap(), sub.to_str().unwrap()).is_err());
    }

    // -- duplicate ------------------------------------------------------------

    #[test]
    fn duplicate_suffixes_and_increments_on_collision() {
        let (dir, a) = granted();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        let p1 = duplicate_entry_impl(&a, f.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&p1), dir.path().join("note copy.md"));
        let p2 = duplicate_entry_impl(&a, f.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&p2), dir.path().join("note copy 2.md"));
    }

    #[test]
    fn duplicate_a_dotted_folder_name_appends_rather_than_splicing() {
        let (dir, a) = granted();
        let folder = dir.path().join("v1.2-release");
        fs::create_dir(&folder).unwrap();
        let p = duplicate_entry_impl(&a, folder.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&p), dir.path().join("v1.2-release copy"));
        assert!(Path::new(&p).is_dir());
    }

    // -- pasted images ---------------------------------------------------------

    #[test]
    fn pasted_image_name_formats_stem_counter_and_ext() {
        assert_eq!(pasted_image_name("note", 1, "png"), "note-pasted-1.png");
        assert_eq!(pasted_image_name("note", 12, "webp"), "note-pasted-12.webp");
        assert_eq!(
            pasted_image_name("a.b-draft", 2, "jpg"),
            "a.b-draft-pasted-2.jpg"
        );
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn save_pasted_image_writes_next_to_the_doc_and_grants_it() {
        let (dir, a) = granted();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# hi").unwrap();
        let (name, abs) =
            save_pasted_image_impl(&a, doc.to_str().unwrap(), &b64(b"PNGDATA"), "png").unwrap();
        assert_eq!(name, "note-pasted-1.png");
        assert_eq!(abs, dir.path().join("note-pasted-1.png"));
        assert_eq!(fs::read(&abs).unwrap(), b"PNGDATA");
        // Granted, so a follow-up read of the image passes ensure.
        assert!(a.ensure(abs.to_str().unwrap()).is_ok());
    }

    #[test]
    fn save_pasted_image_skips_existing_counters() {
        let (dir, a) = granted();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# hi").unwrap();
        fs::write(dir.path().join("note-pasted-1.png"), "old").unwrap();
        let (name, _) =
            save_pasted_image_impl(&a, doc.to_str().unwrap(), &b64(b"x"), "png").unwrap();
        assert_eq!(name, "note-pasted-2.png", "n = first free counter >= 1");
        assert_eq!(
            fs::read_to_string(dir.path().join("note-pasted-1.png")).unwrap(),
            "old",
            "an existing image is never clobbered"
        );
    }

    #[test]
    fn save_pasted_image_rejects_a_non_allowlisted_extension() {
        let (dir, a) = granted();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# hi").unwrap();
        for bad in ["svg", "html", "exe", "PNG", "png/../x", ""] {
            assert!(
                save_pasted_image_impl(&a, doc.to_str().unwrap(), &b64(b"x"), bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn save_pasted_image_rejects_an_ungranted_doc_path() {
        let a = AllowedPaths::default();
        let outside = tempdir().unwrap();
        let doc = outside.path().join("note.md");
        fs::write(&doc, "# hi").unwrap();
        assert!(save_pasted_image_impl(&a, doc.to_str().unwrap(), &b64(b"x"), "png").is_err());
        assert!(
            !outside.path().join("note-pasted-1.png").exists(),
            "nothing written for an unauthorized doc"
        );
    }

    #[test]
    fn save_pasted_image_rejects_invalid_base64() {
        let (dir, a) = granted();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# hi").unwrap();
        assert!(save_pasted_image_impl(&a, doc.to_str().unwrap(), "not base64!!", "png").is_err());
        assert!(!dir.path().join("note-pasted-1.png").exists());
    }

    // -- delete ---------------------------------------------------------------

    #[test]
    fn delete_validates_all_before_trashing_any() {
        let (dir, a) = granted();
        let good = dir.path().join("keep.md");
        fs::write(&good, "x").unwrap();
        let outside = tempdir().unwrap();
        let evil = outside.path().join("evil.md");
        fs::write(&evil, "x").unwrap();
        // A single unauthorized path aborts the batch BEFORE any trash call, so
        // the authorized file is never trashed (this also keeps the test from
        // touching the real Trash on the happy path).
        let paths = vec![
            good.to_str().unwrap().to_string(),
            evil.to_str().unwrap().to_string(),
        ];
        assert!(delete_entries_impl(&a, &paths).is_err());
        assert!(
            good.exists(),
            "no partial trashing when a path is unauthorized"
        );
    }

    #[test]
    fn delete_of_an_unauthorized_path_is_rejected() {
        let a = AllowedPaths::default();
        let outside = tempdir().unwrap();
        let f = outside.path().join("x.md");
        fs::write(&f, "x").unwrap();
        assert!(delete_entries_impl(&a, &[f.to_str().unwrap().to_string()]).is_err());
        assert!(f.exists());
    }

    /// A `trash::delete` failure must map to a fixed IPC-safe message: the
    /// crate's `Error` prints its `Debug` form (embedding an absolute
    /// `PathBuf`) from `Display`, so `.to_string()`-ing it straight into the
    /// command's `Result<_, String>` would leak the user's filesystem layout
    /// to the webview. Forces a real trash failure (delete the file out from
    /// under an exact, existence-independent grant) rather than mocking.
    #[test]
    fn delete_error_never_leaks_the_absolute_path() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        // Never created on disk, so trash::delete is guaranteed to fail.
        // Exact-string grant: unlike allow_root's `ensure`, this does not
        // require the path to exist, so ensure_all still passes and the
        // failure is isolated to trash::delete itself.
        let f = dir.path().join("ghost.md");
        let p = f.to_str().unwrap().to_string();
        a.allow(&p);

        let err = delete_entries_impl(&a, &[p]).unwrap_err();
        assert_eq!(err, "could not move item to Trash");
        assert!(
            !err.contains('/') && !err.contains('\\'),
            "mapped error must not leak the absolute path: {err}"
        );
    }

    /// Delete must be reachable ONLY through the Trash. Assert the module never
    /// names a permanent-unlink API. The needles are assembled from fragments so
    /// this test's own source does not contain the forbidden substring.
    #[test]
    fn module_never_permanently_unlinks() {
        let src = include_str!("fileops.rs");
        let unlink_file = ["fs::remove_", "file"].concat();
        let unlink_dir = ["fs::remove_", "dir"].concat();
        assert!(
            !src.contains(&unlink_file),
            "deletion must route only through the trash crate"
        );
        assert!(
            !src.contains(&unlink_dir),
            "deletion must route only through the trash crate"
        );
    }
}
