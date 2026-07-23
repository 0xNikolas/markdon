use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const GRANT_ERR: &str = "path was not granted by a file dialog, OS open event, or workspace";

/// The shared containment predicate behind every "is this canonical path inside
/// this root" check in the codebase. `starts_with` is component-wise (both sides
/// must be canonical), so a sibling like `/ws-evil` never counts as inside
/// `/ws`. `inclusive` chooses whether the root directory ITSELF passes: strict
/// (`false`) is `ensure`/`owning_root`/image + tab-set containment (the root
/// node is not a file); root-inclusive (`true`) is `ensure_container`, where the
/// root is a valid destination. (`Path::starts_with` is already true on
/// equality, so `inclusive == true` is exactly `starts_with`.)
pub(crate) fn contains(root: &Path, canon: &Path, inclusive: bool) -> bool {
    canon.starts_with(root) && (inclusive || canon != root)
}

/// Paths the webview is allowed to read/write/watch. Only Rust ever inserts:
/// file-dialog picks, OS open events, and workspace-folder grants. The webview
/// can therefore only touch paths the user explicitly granted, even if it is
/// fully compromised.
///
/// Two kinds of grant:
/// - `files`: exact-string grants (dialog picks / OS opens). Matched verbatim —
///   every accepted value is a string this process produced itself.
/// - `roots`: canonicalized directory grants (workspace folders). A path passes
///   iff its canonical form is strictly inside a granted root. Canonicalize
///   resolves `..` AND symlinks and errors on nonexistent paths, so traversal
///   escape, symlink escape, and probe-by-nonexistent-path all fail closed;
///   `Path::starts_with` is component-wise, so a sibling like `/ws-evil` can
///   never match root `/ws`.
#[derive(Default)]
pub struct AllowedPaths {
    files: Mutex<HashSet<String>>,
    roots: Mutex<HashSet<PathBuf>>,
}

impl AllowedPaths {
    /// Grant an exact file path (a dialog pick or OS open event).
    pub fn allow(&self, path: &str) {
        self.files.lock().unwrap().insert(path.to_string());
    }

    /// Grant a directory root. Canonicalizes (resolving `..` and symlinks),
    /// requires it to be an existing directory, and returns the canonical form
    /// so the caller can hand the webview canonical child paths that will pass
    /// `ensure`.
    pub fn allow_root(&self, root: &Path) -> Result<PathBuf, String> {
        let canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !canon.is_dir() {
            return Err("workspace root is not a directory".into());
        }
        self.roots.lock().unwrap().insert(canon.clone());
        Ok(canon)
    }

    /// Verify that `root` is itself a granted workspace root (exact canonical
    /// membership). Used by `list_workspace` so only an actual granted root can
    /// be walked — plain `ensure` deliberately rejects the root directory.
    pub fn ensure_root(&self, root: &str) -> Result<PathBuf, String> {
        let canon = std::fs::canonicalize(root).map_err(|_| GRANT_ERR.to_string())?;
        if self.roots.lock().unwrap().contains(&canon) {
            Ok(canon)
        } else {
            Err(GRANT_ERR.into())
        }
    }

    /// The granted workspace root that owns `canonical` (strictly contains
    /// it), or `None` for standalone / exact-file-grant paths. The LONGEST
    /// matching root wins so nested-root edge cases resolve deterministically
    /// to the closest workspace. Component-wise `starts_with` and the
    /// root-itself exclusion mirror [`ensure`]'s semantics exactly; `canonical`
    /// must already be canonical (both sides canonical is what makes the
    /// comparison sound). Used by history.rs to pick the per-workspace bucket
    /// directory — a read-only classification, never a grant.
    pub fn owning_root(&self, canonical: &Path) -> Option<PathBuf> {
        let roots = self.roots.lock().unwrap();
        roots
            .iter()
            .filter(|r| contains(r.as_path(), canonical, false))
            .max_by_key(|r| r.components().count())
            .cloned()
    }

    pub fn ensure(&self, path: &str) -> Result<(), String> {
        if self.files.lock().unwrap().contains(path) {
            return Ok(());
        }
        // Canonicalize resolves `..` AND symlinks and fails for nonexistent
        // paths, so traversal escape, symlink escape, and nonexistent-path
        // probing all fail closed. starts_with is component-wise: `/ws-evil`
        // can never match root `/ws`. Both sides are canonical, so macOS
        // `/tmp` -> `/private/tmp` aliasing is normalized. The root dir itself
        // never passes (canon != *r), which is intentional.
        let canon = std::fs::canonicalize(path).map_err(|_| GRANT_ERR.to_string())?;
        let roots = self.roots.lock().unwrap();
        if roots.iter().any(|r| contains(r, &canon, false)) {
            Ok(())
        } else {
            Err(GRANT_ERR.into())
        }
    }

    /// Destination-side twin of [`ensure`]: verify `dir` is a directory the
    /// webview may create entries in. Unlike `ensure`, the granted root itself
    /// IS accepted (you can create a file at the workspace root), so this admits
    /// `canon == root` as well as anything strictly inside a root. Returns the
    /// canonical directory so callers build the final path as
    /// `container.join(validated_leaf_name)` — a path that is provably in-root,
    /// which (with a single-component leaf name) is what makes a `../escape`
    /// destination impossible. Canonicalize resolves `..`/symlinks and fails
    /// closed on nonexistent paths, so a `<root>/../sibling` destination
    /// escapes and is rejected exactly as in `ensure`.
    pub fn ensure_container(&self, dir: &str) -> Result<PathBuf, String> {
        let canon = std::fs::canonicalize(dir).map_err(|_| GRANT_ERR.to_string())?;
        if !canon.is_dir() {
            return Err("destination is not a directory".into());
        }
        let roots = self.roots.lock().unwrap();
        if roots.iter().any(|r| contains(r, &canon, true)) {
            Ok(canon)
        } else {
            Err(GRANT_ERR.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn contains_strict_vs_inclusive_at_the_root_and_boundaries() {
        let root = Path::new("/ws");
        // Root itself: excluded when strict, admitted when inclusive.
        assert!(!contains(root, Path::new("/ws"), false));
        assert!(contains(root, Path::new("/ws"), true));
        // Strictly inside: admitted either way.
        assert!(contains(root, Path::new("/ws/a.md"), false));
        assert!(contains(root, Path::new("/ws/a.md"), true));
        // Sibling sharing a string prefix: component-wise, never inside.
        assert!(!contains(root, Path::new("/ws-evil/a.md"), false));
        assert!(!contains(root, Path::new("/ws-evil/a.md"), true));
        // Fully outside: never inside.
        assert!(!contains(root, Path::new("/other/a.md"), false));
    }

    #[test]
    fn ensure_rejects_unknown_path() {
        let a = AllowedPaths::default();
        assert!(a.ensure("/tmp/x.md").is_err());
    }

    #[test]
    fn ensure_accepts_exact_file_grant() {
        let a = AllowedPaths::default();
        a.allow("/tmp/x.md");
        assert!(a.ensure("/tmp/x.md").is_ok());
        // Exact-string semantics for file grants: no path algebra, so a `..`
        // dressing of a granted string is not itself a granted string. (It is
        // also a nonexistent path, so canonicalize fails too — belt and braces.)
        assert!(
            a.ensure("/tmp/x.md/../y.md").is_err(),
            "file grants are exact strings only"
        );
    }

    #[test]
    fn root_grant_admits_file_directly_inside() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        assert!(a.ensure(f.to_str().unwrap()).is_ok());
    }

    #[test]
    fn root_grant_admits_file_in_nested_subdir() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        let sub = dir.path().join("a").join("b");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("deep.md");
        fs::write(&f, "x").unwrap();
        assert!(a.ensure(f.to_str().unwrap()).is_ok());
    }

    #[test]
    fn root_itself_is_rejected_by_ensure() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        let canon = a.allow_root(dir.path()).unwrap();
        // The root directory is granted for listing (ensure_root) but must not
        // pass the file guard: you cannot read/write the directory node itself.
        assert!(a.ensure(canon.to_str().unwrap()).is_err());
    }

    #[test]
    fn sibling_with_shared_string_prefix_is_rejected() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        let evil = parent.path().join("ws-evil");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&evil).unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        let f = evil.join("x.md");
        fs::write(&f, "x").unwrap();
        // starts_with is component-wise, so /…/ws-evil does NOT start_with /…/ws.
        assert!(a.ensure(f.to_str().unwrap()).is_err());
    }

    #[test]
    fn traversal_escape_out_of_root_is_rejected() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let outside = parent.path().join("outside.md");
        fs::write(&outside, "secret").unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        // A `..` escape resolves out of the root once canonicalized.
        let probe = ws.join("..").join("outside.md");
        assert!(a.ensure(probe.to_str().unwrap()).is_err());
    }

    #[test]
    fn nonexistent_path_under_root_is_rejected() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        let ghost = dir.path().join("does-not-exist.md");
        // canonicalize fails for a nonexistent path -> fail closed. (New files
        // get an exact grant from the save dialog instead.)
        assert!(a.ensure(ghost.to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_root_pointing_outside_is_rejected() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let secret = parent.path().join("secret.md");
        fs::write(&secret, "top secret").unwrap();
        let link = ws.join("link.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        // canonicalize resolves the symlink to /…/secret.md, outside the root.
        assert!(a.ensure(link.to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn probe_through_symlinked_parent_still_passes() {
        // Grant a real dir, then probe a file inside it via a symlinked alias of
        // the parent. Both sides canonicalize to the same real path, so it must
        // pass — asserts we canonicalize both the grant and the probe.
        let real = tempdir().unwrap();
        let ws = real.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let f = ws.join("note.md");
        fs::write(&f, "x").unwrap();

        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();

        let alias_parent = tempdir().unwrap();
        let alias = alias_parent.path().join("alias");
        std::os::unix::fs::symlink(&ws, &alias).unwrap();
        let via_alias = alias.join("note.md");
        assert!(a.ensure(via_alias.to_str().unwrap()).is_ok());
    }

    #[test]
    fn allow_root_on_a_file_errors() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("a.md");
        fs::write(&f, "x").unwrap();
        let a = AllowedPaths::default();
        assert!(a.allow_root(&f).is_err());
    }

    #[test]
    fn allow_root_on_nonexistent_dir_errors() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        assert!(a.allow_root(&dir.path().join("nope")).is_err());
    }

    #[test]
    fn ensure_container_accepts_the_granted_root_itself() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        let canon = a.allow_root(dir.path()).unwrap();
        // Root IS a valid destination container (files can be created at the
        // workspace root), unlike `ensure` which rejects the root node.
        assert!(a.ensure_container(canon.to_str().unwrap()).is_ok());
        assert!(a.ensure(canon.to_str().unwrap()).is_err());
    }

    #[test]
    fn ensure_container_accepts_a_nested_dir() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        let sub = dir.path().join("a").join("b");
        fs::create_dir_all(&sub).unwrap();
        let got = a.ensure_container(sub.to_str().unwrap()).unwrap();
        assert_eq!(got, fs::canonicalize(&sub).unwrap());
    }

    #[test]
    fn ensure_container_rejects_a_sibling_dir() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        let evil = parent.path().join("ws-evil");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&evil).unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        // Component-wise starts_with: /…/ws-evil never counts as inside /…/ws.
        assert!(a.ensure_container(evil.to_str().unwrap()).is_err());
    }

    #[test]
    fn ensure_container_rejects_a_traversal_escape_destination() {
        // The crux for move/copy: a `<root>/../outside` destination directory
        // canonicalizes out of the root and must be rejected.
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let outside = parent.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        let escape = ws.join("..").join("outside");
        assert!(a.ensure_container(escape.to_str().unwrap()).is_err());
    }

    #[test]
    fn ensure_container_rejects_a_non_directory() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        a.allow_root(dir.path()).unwrap();
        let f = dir.path().join("note.md");
        fs::write(&f, "x").unwrap();
        // A file inside the root passes `ensure` but is not a valid container.
        assert!(a.ensure(f.to_str().unwrap()).is_ok());
        assert!(a.ensure_container(f.to_str().unwrap()).is_err());
    }

    #[test]
    fn ensure_container_rejects_an_ungranted_dir() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        // Nothing granted at all.
        assert!(a.ensure_container(dir.path().to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_container_rejects_a_symlinked_dir_escaping_root() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let secret = parent.path().join("secret");
        fs::create_dir_all(&secret).unwrap();
        let link = ws.join("link");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let a = AllowedPaths::default();
        a.allow_root(&ws).unwrap();
        // canonicalize resolves the symlink to /…/secret, outside the root.
        assert!(a.ensure_container(link.to_str().unwrap()).is_err());
    }

    #[test]
    fn owning_root_returns_the_containing_root() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        let canon = a.allow_root(dir.path()).unwrap();
        let f = canon.join("note.md");
        fs::write(&f, "x").unwrap();
        assert_eq!(a.owning_root(&f), Some(canon));
    }

    #[test]
    fn owning_root_excludes_the_root_itself_and_ungranted_paths() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        let canon = a.allow_root(dir.path()).unwrap();
        // The root node itself is not "inside" a workspace — same exclusion
        // as ensure's.
        assert_eq!(a.owning_root(&canon), None);
        assert_eq!(a.owning_root(Path::new("/somewhere/else.md")), None);
    }

    #[test]
    fn owning_root_prefers_the_longest_nested_root() {
        let dir = tempdir().unwrap();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let a = AllowedPaths::default();
        let outer_canon = a.allow_root(&outer).unwrap();
        let inner_canon = a.allow_root(&inner).unwrap();
        let f = inner_canon.join("deep.md");
        fs::write(&f, "x").unwrap();
        // Both roots contain f; the closest (longest) one wins.
        assert_eq!(a.owning_root(&f), Some(inner_canon.clone()));
        // A file only in the outer root still resolves to the outer root.
        let g = outer_canon.join("shallow.md");
        fs::write(&g, "x").unwrap();
        assert_eq!(a.owning_root(&g), Some(outer_canon));
    }

    #[test]
    fn ensure_root_requires_exact_root_membership() {
        let dir = tempdir().unwrap();
        let a = AllowedPaths::default();
        let canon = a.allow_root(dir.path()).unwrap();
        assert!(a.ensure_root(canon.to_str().unwrap()).is_ok());
        // A subdir of a granted root is not itself a granted root.
        let sub = dir.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        assert!(a.ensure_root(sub.to_str().unwrap()).is_err());
    }
}
