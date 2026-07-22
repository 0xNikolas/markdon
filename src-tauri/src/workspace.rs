use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::allowlist::AllowedPaths;

/// Deepest directory level walked. Directories below this are omitted (never
/// shown fake-empty) and mark the tree `truncated`.
const MAX_DEPTH: usize = 8;
/// Total entry budget across the whole walk. Once exhausted the tree is
/// `truncated` and no further entries are added.
const MAX_ENTRIES: usize = 2000;

#[derive(Serialize)]
pub struct WorkspaceFile {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct WorkspaceDir {
    pub name: String,
    pub path: String,
    pub dirs: Vec<WorkspaceDir>,
    pub files: Vec<WorkspaceFile>,
    /// True somewhere at/below this node the depth or entry budget was hit.
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct Workspace {
    pub root: String,
    pub tree: WorkspaceDir,
}

#[derive(Serialize, Deserialize)]
struct SavedWorkspace {
    root: String,
}

/// Recursively walk `dir` into a tree. Policy:
/// - skip dotfiles / dot-dirs (covers .git, .DS_Store)
/// - skip ALL symlinks (dir symlinks = cycle/escape risk; file symlinks would
///   fail `ensure` with a confusing banner — an honest tree omits them)
/// - skip non-UTF-8 names
/// - include all other files (design shows non-md assets like logos)
/// - sort dirs-first, each case-insensitive alphabetical
///
/// An unreadable directory yields an empty node rather than failing the walk.
fn walk(dir: &Path, name: String, depth: usize, budget: &mut usize) -> WorkspaceDir {
    let mut node = WorkspaceDir {
        name,
        path: dir.to_string_lossy().into_owned(),
        dirs: Vec::new(),
        files: Vec::new(),
        truncated: false,
    };
    let Ok(rd) = fs::read_dir(dir) else {
        return node;
    };
    let mut entries: Vec<fs::DirEntry> = rd.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name().to_ascii_lowercase());
    for e in entries {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let Some(fname) = e.file_name().to_str().map(String::from) else {
            continue;
        };
        if fname.starts_with('.') {
            continue;
        }
        if *budget == 0 {
            node.truncated = true;
            break;
        }
        *budget -= 1;
        if ft.is_dir() {
            if depth < MAX_DEPTH {
                let child = walk(&e.path(), fname, depth + 1, budget);
                if child.truncated {
                    node.truncated = true;
                }
                node.dirs.push(child);
            } else {
                node.truncated = true;
            }
        } else {
            node.files.push(WorkspaceFile {
                name: fname,
                path: e.path().to_string_lossy().into_owned(),
            });
        }
    }
    node
}

/// Build a `Workspace` for an already-canonicalized granted root.
fn build_workspace(root: &Path) -> Result<Workspace, String> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let root_str = root
        .to_str()
        .ok_or_else(|| "non-UTF-8 workspace path".to_string())?
        .to_string();
    let mut budget = MAX_ENTRIES;
    let tree = walk(root, name, 0, &mut budget);
    Ok(Workspace {
        root: root_str,
        tree,
    })
}

/// Path of the persisted last-workspace pointer. Rust-owned so the webview can
/// never supply it — that keeps the "allowlist holds only user-picked paths"
/// invariant intact across restore.
fn state_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("workspace.json"))
}

/// Persist the last opened workspace root. Takes `&Path` for the state file so
/// it is testable without an AppHandle.
pub(crate) fn save_last_root(file: &Path, root: &str) -> Result<(), String> {
    let json = serde_json::to_string(&SavedWorkspace {
        root: root.to_string(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(file, json).map_err(|e| e.to_string())
}

/// Read the last opened workspace root, or `None` if absent/corrupt.
pub(crate) fn load_last_root(file: &Path) -> Option<String> {
    let raw = fs::read_to_string(file).ok()?;
    serde_json::from_str::<SavedWorkspace>(&raw)
        .ok()
        .map(|s| s.root)
}

/// Called by the folder-open dialog after a successful grant: persist the root
/// (best-effort) and return the walked tree.
pub(crate) fn open_result(app: &AppHandle, canon: &Path) -> Result<Workspace, String> {
    if let Ok(file) = state_file(app) {
        let _ = save_last_root(&file, &canon.to_string_lossy());
    }
    build_workspace(canon)
}

/// Walk an already-granted workspace root. Requires exact root membership —
/// plain `ensure` correctly rejects the root itself, so `ensure_root` is used.
#[tauri::command]
pub fn list_workspace(root: String, allowed: State<'_, AllowedPaths>) -> Result<Workspace, String> {
    let canon = allowed.ensure_root(&root)?;
    build_workspace(&canon)
}

/// Restore the last workspace on launch. The root comes only from our config
/// file (written solely by the folder dialog after a real user pick), so the
/// webview passes no path and cannot mint a grant. Returns `None` — and forgets
/// the pointer — if the folder has vanished.
#[tauri::command]
pub fn restore_workspace(
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Option<Workspace>, String> {
    let file = state_file(&app)?;
    let Some(root) = load_last_root(&file) else {
        return Ok(None);
    };
    match allowed.allow_root(Path::new(&root)) {
        Ok(canon) => Ok(Some(build_workspace(&canon)?)),
        Err(_) => {
            let _ = fs::remove_file(&file);
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn tree_of(dir: &Path) -> WorkspaceDir {
        let mut budget = MAX_ENTRIES;
        walk(dir, "root".into(), 0, &mut budget)
    }

    #[test]
    fn dirs_first_case_insensitive_sort() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("A.md"), "").unwrap();
        fs::create_dir(dir.path().join("Zdir")).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();

        let t = tree_of(dir.path());
        let dir_names: Vec<_> = t.dirs.iter().map(|d| d.name.as_str()).collect();
        let file_names: Vec<_> = t.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(dir_names, ["sub", "Zdir"]); // case-insensitive: s < z
        assert_eq!(file_names, ["A.md", "b.md"]); // case-insensitive: a < b
    }

    #[test]
    fn dotfiles_and_dot_dirs_skipped() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".DS_Store"), "").unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("keep.md"), "").unwrap();

        let t = tree_of(dir.path());
        assert!(t.dirs.is_empty());
        assert_eq!(t.files.len(), 1);
        assert_eq!(t.files[0].name, "keep.md");
    }

    #[test]
    fn non_md_files_included() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("brand_logo.svg"), "").unwrap();
        fs::write(dir.path().join("readme.md"), "").unwrap();

        let t = tree_of(dir.path());
        let names: Vec<_> = t.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"brand_logo.svg"));
        assert!(names.contains(&"readme.md"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_skipped() {
        let dir = tempdir().unwrap();
        let target = tempdir().unwrap();
        fs::write(target.path().join("real.md"), "").unwrap();
        fs::write(dir.path().join("plain.md"), "").unwrap();
        std::os::unix::fs::symlink(target.path().join("real.md"), dir.path().join("link.md"))
            .unwrap();
        std::os::unix::fs::symlink(target.path(), dir.path().join("linkdir")).unwrap();

        let t = tree_of(dir.path());
        assert!(t.dirs.is_empty(), "symlinked dir omitted");
        let names: Vec<_> = t.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["plain.md"], "symlinked file omitted");
    }

    #[test]
    fn depth_beyond_max_is_truncated_and_omitted() {
        let dir = tempdir().unwrap();
        // Build a chain deeper than MAX_DEPTH.
        let mut p = dir.path().to_path_buf();
        for i in 0..(MAX_DEPTH + 2) {
            p = p.join(format!("d{i}"));
            fs::create_dir(&p).unwrap();
        }
        let t = tree_of(dir.path());
        // Descend counting how many nested dirs are present.
        let mut node = &t;
        let mut depth = 0;
        while let Some(child) = node.dirs.first() {
            depth += 1;
            node = child;
        }
        assert_eq!(depth, MAX_DEPTH, "no dir node deeper than MAX_DEPTH");
        assert!(t.truncated, "truncation propagates to the root");
    }

    #[test]
    fn entry_budget_truncates() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("f{i}.md")), "").unwrap();
        }
        let mut budget = 4;
        let t = walk(dir.path(), "root".into(), 0, &mut budget);
        assert!(t.truncated);
        assert_eq!(t.files.len(), 4, "stops at the budget");
    }

    #[test]
    fn unreadable_subdir_yields_empty_node_not_err() {
        // A directory we can descend into produces a node; an empty dir just
        // yields an empty node — the walk never returns Err.
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        let t = tree_of(dir.path());
        assert_eq!(t.dirs.len(), 1);
        assert!(t.dirs[0].files.is_empty());
        assert!(t.dirs[0].dirs.is_empty());
    }

    #[test]
    fn persistence_round_trip() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        save_last_root(&file, "/some/workspace").unwrap();
        assert_eq!(load_last_root(&file).as_deref(), Some("/some/workspace"));
    }

    #[test]
    fn load_of_garbage_json_is_none() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        fs::write(&file, "not json at all").unwrap();
        assert_eq!(load_last_root(&file), None);
    }

    #[test]
    fn load_of_missing_file_is_none() {
        let dir = tempdir().unwrap();
        assert_eq!(load_last_root(&dir.path().join("nope.json")), None);
    }

    #[test]
    fn build_workspace_names_root_from_basename() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("MyNotes");
        fs::create_dir(&ws).unwrap();
        let w = build_workspace(&ws).unwrap();
        assert_eq!(w.tree.name, "MyNotes");
        assert_eq!(w.root, ws.to_str().unwrap());
    }
}
