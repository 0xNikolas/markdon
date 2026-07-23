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

/// Legacy (pre-MRU) shape of workspace.json: a bare restore pointer. Kept only
/// so `load_state` can migrate an existing install's file on first read.
#[derive(Serialize, Deserialize)]
struct SavedWorkspace {
    root: String,
}

/// Newest-first Open Recent entries kept in `WorkspaceState::roots`.
const MAX_RECENTS: usize = 10;

/// Persisted workspace state (`workspace.json`): the launch-restore pointer
/// (`current`) plus the Open Recent MRU list (`roots`, newest-first, deduped,
/// capped at `MAX_RECENTS`). The two are DIFFERENT concepts on purpose —
/// closing a folder clears `current` (next launch starts folder-less) while
/// KEEPING its `roots` entry reachable from Open Recent.
///
/// The file is shared by every running instance; writes go through
/// `history::atomic_write`, so concurrent read-modify-writes are whole-file
/// last-writer-wins (two instances bumping the MRU at once can drop one bump)
/// but never torn — exactly prefs.rs's documented posture for settings.json.
#[derive(Serialize, Deserialize)]
pub(crate) struct WorkspaceState {
    pub version: u32,
    pub current: Option<String>,
    pub roots: Vec<String>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        WorkspaceState {
            version: 2,
            current: None,
            roots: Vec::new(),
        }
    }
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

/// Path of the persisted workspace state (restore pointer + MRU). Rust-owned
/// so the webview can never supply it — that keeps the "allowlist holds only
/// user-picked paths" invariant intact across restore.
pub(crate) fn state_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("workspace.json"))
}

/// Read the workspace state, tolerantly: the v2 shape parses as-is; a legacy
/// `{"root": …}` pointer migrates in-memory to `{current, roots: [root]}` (the
/// write side always emits v2, so the migration is one read); garbage or a
/// missing file yields the empty default — mirroring settings.ts's
/// tolerant-parse posture so a corrupt file can never break an open.
pub(crate) fn load_state(file: &Path) -> WorkspaceState {
    let Ok(raw) = fs::read_to_string(file) else {
        return WorkspaceState::default();
    };
    if let Ok(state) = serde_json::from_str::<WorkspaceState>(&raw) {
        return state;
    }
    if let Ok(legacy) = serde_json::from_str::<SavedWorkspace>(&raw) {
        return WorkspaceState {
            version: 2,
            current: Some(legacy.root.clone()),
            roots: vec![legacy.root],
        };
    }
    WorkspaceState::default()
}

/// Atomically replace the workspace state. The file is a read-modify-write
/// shared across instances, so unlike the old bare-pointer `fs::write` this
/// must never leave a torn file (lost whole-file updates stay accepted — see
/// `WorkspaceState`).
fn save_state(file: &Path, state: &WorkspaceState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    crate::history::atomic_write(file, json.as_bytes()).map_err(|e| e.to_string())
}

/// Bump `root` to the front of the MRU: remove any existing occurrence, insert
/// newest-first, cap at `MAX_RECENTS`. Pure, so it is testable without I/O.
pub(crate) fn touch_recent(roots: &mut Vec<String>, root: &str) {
    roots.retain(|r| r != root);
    roots.insert(0, root.to_string());
    roots.truncate(MAX_RECENTS);
}

/// Persist a successful open: set the restore pointer AND bump the MRU.
pub(crate) fn persist_open(file: &Path, root: &str) -> Result<(), String> {
    let mut state = load_state(file);
    state.current = Some(root.to_string());
    touch_recent(&mut state.roots, root);
    save_state(file, &state)
}

/// Read the launch-restore pointer, or `None` if absent/corrupt.
pub(crate) fn load_last_root(file: &Path) -> Option<String> {
    load_state(file).current
}

/// Called by the folder-open dialog after a successful grant: persist the
/// root and MRU bump (best-effort), refresh the Open Recent menu, and return
/// the walked tree.
pub(crate) fn open_result(app: &AppHandle, canon: &Path) -> Result<Workspace, String> {
    if let Ok(file) = state_file(app) {
        let _ = persist_open(&file, &canon.to_string_lossy());
    }
    crate::menu::sync_recent_menu(app);
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
        crate::menu::sync_recent_menu(&app);
        return Ok(None);
    };
    match allowed.allow_root(Path::new(&root)) {
        Ok(canon) => {
            crate::allow_asset_dir(&app, &canon, true);
            let ws = build_workspace(&canon)?;
            crate::menu::sync_recent_menu(&app);
            Ok(Some(ws))
        }
        Err(_) => {
            // The folder vanished: clear the pointer AND drop the dead entry
            // from the MRU (a vanished folder must not linger in Open Recent).
            let mut state = load_state(&file);
            state.current = None;
            state.roots.retain(|r| r != &root);
            let _ = save_state(&file, &state);
            crate::menu::sync_recent_menu(&app);
            Ok(None)
        }
    }
}

/// Clear the persisted restore pointer, but only when this instance actually
/// OWNS it: the state file is shared by every running instance, and an
/// instance whose folder was never persisted (spawned with `--workspace`,
/// which deliberately skips persistence) closing its folder must not clear the
/// pointer some OTHER instance saved. `root` is compared against the persisted
/// value — mismatch, missing, or corrupt state is a successful no-op (the
/// tolerant `load_state` yields `current: None` for the latter two). Only
/// `current` is cleared; the MRU entry is deliberately KEPT so the closed
/// folder stays reachable from Open Recent. Takes `&Path` so it is testable
/// without an AppHandle.
pub(crate) fn close_if_owned(file: &Path, root: &str) -> Result<(), String> {
    let mut state = load_state(file);
    if state.current.as_deref() != Some(root) {
        return Ok(());
    }
    state.current = None;
    save_state(file, &state)
}

/// Forget the persisted last-workspace pointer so the next launch starts
/// folder-less. Only the pointer is cleared — the folder's Open Recent entry
/// stays, and the in-memory allowlist grant is deliberately kept, because
/// files from the closed folder may still be open (VS Code behavior) and must
/// stay readable/savable until the app exits. A missing state file is success,
/// not an error: closing twice is a no-op.
///
/// `root` (the closing instance's current workspace) is used ONLY to prove
/// ownership of the pointer — see `close_if_owned` — never to mint a grant or
/// touch the filesystem beyond the Rust-owned pointer file, so accepting it
/// from the webview does not weaken the allowlist invariant.
#[tauri::command]
pub fn close_workspace(root: String, app: AppHandle) -> Result<(), String> {
    let file = state_file(&app)?;
    close_if_owned(&file, &root)
}

/// What a launch hand-off resolved to: the adopted workspace (if any) plus
/// whether the ordinary restore must be skipped. The two are separate on
/// purpose — `workspace: None` alone cannot distinguish "cold launch, go
/// restore" from "handed-off child whose dir vanished (or that carried only
/// files), start folder-less". Field names serialize verbatim, matching every
/// other payload in this codebase (no serde renames).
#[derive(Serialize)]
pub struct StartupHandoff {
    pub workspace: Option<Workspace>,
    pub suppress_restore: bool,
}

/// Adopt the workspace this process was launched with (`--workspace <dir>` in
/// argv, stashed in `StartupWorkspace` by `run()`). Take-once: a re-mount gets
/// `workspace: None`. Grants + walks exactly like restore, but deliberately
/// does NOT persist to workspace.json — the spawned instance must not clobber
/// the restore pointer of the instance that spawned it. Fail-softs to
/// `workspace: None` if the dir vanished before launch finished — but the
/// accompanying `suppress_restore` (true for every handed-off launch, even
/// files-only ones) still tells the frontend to start folder-less rather than
/// fall back to `restore_workspace` and silently adopt the SPAWNER's folder.
#[tauri::command]
pub fn take_startup_workspace(
    app: AppHandle,
    startup: State<'_, crate::launch::StartupWorkspace>,
    allowed: State<'_, AllowedPaths>,
) -> Result<StartupHandoff, String> {
    let suppress_restore = startup.suppress_restore();
    let workspace = match startup.take() {
        Some(dir) => match allowed.allow_root(&dir) {
            Ok(canon) => {
                crate::allow_asset_dir(&app, &canon, true);
                // Bump the MRU WITHOUT touching `current`: the split schema
                // makes this safe for the first time — the sprint-2 invariant
                // ("a spawned child must not clobber the spawner's restore
                // pointer") only ever protected the pointer, and a folder the
                // user opened in a second instance belongs in Open Recent.
                if let Ok(file) = state_file(&app) {
                    let mut state = load_state(&file);
                    touch_recent(&mut state.roots, &canon.to_string_lossy());
                    let _ = save_state(&file, &state);
                }
                crate::menu::sync_recent_menu(&app);
                Some(build_workspace(&canon)?)
            }
            Err(_) => None,
        },
        None => None,
    };
    Ok(StartupHandoff {
        workspace,
        suppress_restore,
    })
}

/// How a valid Open Recent pick is honored — resolved by [`resolve_recent`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecentDecision {
    /// This instance already has a folder open: spawn a new instance for the
    /// root (VS Code second-window semantics).
    Spawn,
    /// Folder-less instance: grant + walk + persist in place, like a dialog pick.
    Adopt,
}

/// Decision core of [`open_recent_workspace`], AppHandle-free so it is
/// unit-testable (the `record_snapshot` pattern in history.rs). Enforces the
/// trust boundary — `root` must be an entry of the Rust-written MRU, or the
/// pick is rejected before any grant/spawn — then picks spawn-vs-adopt from
/// whether this instance already has a folder open.
pub(crate) fn resolve_recent(
    file: &Path,
    root: &str,
    has_current: bool,
) -> Result<RecentDecision, String> {
    let state = load_state(file);
    if !state.roots.iter().any(|r| r == root) {
        return Err("not a recent workspace".into());
    }
    Ok(if has_current {
        RecentDecision::Spawn
    } else {
        RecentDecision::Adopt
    })
}

/// Drop a vanished folder's entry from the MRU (leaving every other entry, and
/// the restore pointer, untouched) so it disappears from Open Recent.
/// AppHandle-free for the same testability reason as [`resolve_recent`].
pub(crate) fn drop_dead_recent(file: &Path, root: &str) -> Result<(), String> {
    let mut state = load_state(file);
    state.roots.retain(|r| r != root);
    save_state(file, &state)
}

/// Reopen an entry of the Open Recent menu. Trust boundary (same pattern as
/// `close_if_owned` proving ownership by comparison against Rust-persisted
/// state): `root` must be an entry of the Rust-written MRU — every entry was
/// persisted only after a real dialog pick / argv hand-off in SOME instance,
/// so the webview can replay a past grant-decision but never mint a grant for
/// an arbitrary path. See [`resolve_recent`], which holds that check.
///
/// `current_root: Some(_)` (this instance already has a folder open) spawns a
/// new instance for `root` and returns `Ok(None)` — VS Code second-window
/// semantics, identical to `pick_folder_new_instance` minus the dialog.
/// `current_root: None` adopts in place: grant, walk, persist, exactly like a
/// dialog pick. A vanished folder is dropped from the MRU and surfaced as an
/// error for the banner.
#[tauri::command]
pub fn open_recent_workspace(
    root: String,
    current_root: Option<String>,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Option<Workspace>, String> {
    let file = state_file(&app)?;
    match resolve_recent(&file, &root, current_root.is_some())? {
        RecentDecision::Spawn => {
            crate::dialogs::spawn_workspace_instance(&root)?;
            Ok(None)
        }
        RecentDecision::Adopt => match allowed.allow_root(Path::new(&root)) {
            Ok(canon) => {
                // Recursive display-only grant: an explicitly recent-picked
                // whole folder, same justification as open_workspace_dialog.
                crate::allow_asset_dir(&app, &canon, true);
                // open_result persists current + bumps the MRU + syncs the menu.
                Ok(Some(open_result(&app, &canon)?))
            }
            Err(e) => {
                // Dead entry: drop it from the MRU so it leaves the menu, then
                // let the frontend banner the failure.
                let _ = drop_dead_recent(&file, &root);
                crate::menu::sync_recent_menu(&app);
                Err(e)
            }
        },
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
        persist_open(&file, "/some/workspace").unwrap();
        assert_eq!(load_last_root(&file).as_deref(), Some("/some/workspace"));
        assert_eq!(load_state(&file).roots, vec!["/some/workspace"]);
    }

    #[test]
    fn load_of_garbage_json_is_none() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        fs::write(&file, "not json at all").unwrap();
        assert_eq!(load_last_root(&file), None);
        assert!(load_state(&file).roots.is_empty());
    }

    #[test]
    fn load_of_missing_file_is_none() {
        let dir = tempdir().unwrap();
        assert_eq!(load_last_root(&dir.path().join("nope.json")), None);
    }

    #[test]
    fn load_migrates_the_legacy_bare_pointer_shape() {
        // A pre-MRU {"root": …} file must surface as current AND seed the MRU.
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        fs::write(&file, r#"{"root":"/ws/old"}"#).unwrap();
        let state = load_state(&file);
        assert_eq!(state.current.as_deref(), Some("/ws/old"));
        assert_eq!(state.roots, vec!["/ws/old"]);
        assert_eq!(state.version, 2);
    }

    #[test]
    fn touch_recent_dedupes_fronts_and_caps() {
        let mut roots: Vec<String> = Vec::new();
        for i in 0..12 {
            touch_recent(&mut roots, &format!("/ws/{i}"));
        }
        assert_eq!(roots.len(), 10, "capped at MAX_RECENTS");
        assert_eq!(roots[0], "/ws/11", "newest first");
        assert!(!roots.contains(&"/ws/0".to_string()), "oldest evicted");
        // Re-opening an existing entry moves it to the front without a dup.
        touch_recent(&mut roots, "/ws/5");
        assert_eq!(roots[0], "/ws/5");
        assert_eq!(
            roots.iter().filter(|r| *r == "/ws/5").count(),
            1,
            "no duplicate entries"
        );
        assert_eq!(roots.len(), 10);
    }

    #[test]
    fn persist_open_sets_current_and_bumps_the_mru() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/a").unwrap();
        persist_open(&file, "/ws/b").unwrap();
        let state = load_state(&file);
        assert_eq!(state.current.as_deref(), Some("/ws/b"));
        assert_eq!(state.roots, vec!["/ws/b", "/ws/a"]);
    }

    #[test]
    fn close_if_owned_clears_the_pointer_but_keeps_the_mru_entry() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/f1").unwrap();
        close_if_owned(&file, "/ws/f1").unwrap();
        let state = load_state(&file);
        assert_eq!(state.current, None, "owned pointer is cleared");
        assert_eq!(
            state.roots,
            vec!["/ws/f1"],
            "the closed folder stays reachable from Open Recent"
        );
    }

    #[test]
    fn close_if_owned_leaves_another_instances_pointer_alone() {
        // Instance B (spawned with --workspace /ws/f2, never persisted) closing
        // its folder must not clear instance A's /ws/f1 pointer.
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/f1").unwrap();
        close_if_owned(&file, "/ws/f2").unwrap();
        assert_eq!(load_last_root(&file).as_deref(), Some("/ws/f1"));
    }

    #[test]
    fn close_if_owned_with_no_pointer_is_ok() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        assert_eq!(close_if_owned(&file, "/ws/f1"), Ok(()));
    }

    #[test]
    fn close_if_owned_with_a_corrupt_pointer_is_a_no_op() {
        // A pointer nobody can prove ownership of is left for the instance
        // that can (or for restore_workspace to clean up): the tolerant load
        // yields current: None, so nothing matches and nothing is written.
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        fs::write(&file, "not json at all").unwrap();
        assert_eq!(close_if_owned(&file, "/ws/f1"), Ok(()));
        assert_eq!(fs::read_to_string(&file).unwrap(), "not json at all");
    }

    #[test]
    fn state_round_trips_through_atomic_write() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        let state = WorkspaceState {
            version: 2,
            current: Some("/ws/a".into()),
            roots: vec!["/ws/a".into(), "/ws/b".into()],
        };
        save_state(&file, &state).unwrap();
        let back = load_state(&file);
        assert_eq!(back.current.as_deref(), Some("/ws/a"));
        assert_eq!(back.roots, vec!["/ws/a", "/ws/b"]);
    }

    #[test]
    fn resolve_recent_rejects_a_root_absent_from_the_mru() {
        // The trust boundary: a webview-supplied root that was never persisted
        // by a real pick must be rejected before any grant or spawn.
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/a").unwrap();
        let res = resolve_recent(&file, "/ws/never-picked", false);
        assert_eq!(res, Err("not a recent workspace".into()));
        // Same rejection regardless of the spawn-vs-adopt branch.
        assert!(resolve_recent(&file, "/ws/never-picked", true).is_err());
    }

    #[test]
    fn resolve_recent_rejects_everything_when_no_state_exists() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("nope.json");
        assert!(resolve_recent(&file, "/ws/a", false).is_err());
    }

    #[test]
    fn resolve_recent_spawns_when_a_folder_is_already_open() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/a").unwrap();
        assert_eq!(
            resolve_recent(&file, "/ws/a", true),
            Ok(RecentDecision::Spawn)
        );
    }

    #[test]
    fn resolve_recent_adopts_in_place_when_folder_less() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/a").unwrap();
        assert_eq!(
            resolve_recent(&file, "/ws/a", false),
            Ok(RecentDecision::Adopt)
        );
    }

    #[test]
    fn drop_dead_recent_removes_exactly_the_dead_entry_preserving_order() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        persist_open(&file, "/ws/a").unwrap();
        persist_open(&file, "/ws/dead").unwrap();
        persist_open(&file, "/ws/c").unwrap(); // MRU: [c, dead, a], current: c
        drop_dead_recent(&file, "/ws/dead").unwrap();
        let state = load_state(&file);
        assert_eq!(state.roots, vec!["/ws/c", "/ws/a"], "order preserved");
        assert_eq!(
            state.current.as_deref(),
            Some("/ws/c"),
            "the restore pointer is untouched"
        );
        // Dropping an entry that isn't there is a harmless no-op.
        drop_dead_recent(&file, "/ws/dead").unwrap();
        assert_eq!(load_state(&file).roots, vec!["/ws/c", "/ws/a"]);
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
