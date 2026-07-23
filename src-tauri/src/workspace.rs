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

/// The Open Recent MRU as the frontend's empty page consumes it: newest-first
/// roots from the shared state file. Pure (`&Path` in, no AppHandle) so the
/// command below stays a trivial shell — the `record_snapshot` testability
/// pattern used throughout this file.
pub(crate) fn recent_roots(file: &Path) -> Vec<String> {
    load_state(file).roots
}

/// Newest-first recent workspace roots for the empty page's Recent section.
/// Read-only against the Rust-owned state file — no grant is minted and
/// nothing is persisted; actually OPENING a listed root still routes through
/// `open_recent_workspace`, whose MRU-membership check is the trust boundary.
#[tauri::command]
pub fn list_recent_workspaces(app: AppHandle) -> Result<Vec<String>, String> {
    let file = state_file(&app)?;
    Ok(recent_roots(&file))
}

// -- per-workspace UI state (the open-tab set) -------------------------------

/// Upper bound on a workspace's ui.json. The payload is a list of paths; at
/// ~200 bytes/path this cap still holds ~300 tabs, so it only ever stops a
/// compromised webview using the file as an arbitrary-size disk sink
/// (prefs.rs's posture for settings.json).
const MAX_UI_STATE_BYTES: u64 = 64 * 1024;

/// Persisted per-workspace UI state (v2), stored at
/// `app_data_dir()/workspace-state/<sha256hex(canonical root)>/ui.json` — the
/// per-workspace state directory prefs.rs documents (history buckets are the
/// other tenant). Records the whole Open Files strip so reopening a workspace
/// rebuilds it: `tabs` are the pinned rows in strip order, `preview` is the
/// volatile italic row (never one of `tabs`), `active` is the file showing in
/// the editor (one of `tabs`, or `preview`, or `None` for a scratch). Field
/// names already match the requested `{version,tabs,preview,active}` JSON, so
/// no serde renames — and this is a Rust-owned file format, not an IPC
/// payload, so the no-serde-renames payload rule doesn't apply either way.
#[derive(Serialize, Deserialize)]
struct UiStateV2 {
    version: u32,
    tabs: Vec<String>,
    #[serde(default)]
    preview: Option<String>,
    #[serde(default)]
    active: Option<String>,
}

/// The pre-tab-set v1 shape (`{"version":1,"lastFile":…}`), kept only so a
/// `load_ui_state` of an existing install's file migrates it in-memory: its
/// single `lastFile` becomes the restored `active` (with no pinned tabs). The
/// write side only ever emits v2, so the migration is a one-time read.
#[derive(Deserialize)]
struct UiStateV1 {
    #[serde(rename = "lastFile")]
    last_file: String,
}

/// The workspace's restored tab set, as the frontend consumes it. Field names
/// serialize verbatim (no serde renames), matching every other IPC payload in
/// this codebase. `preview`/`active` are `null` when absent.
#[derive(Serialize, PartialEq, Debug)]
pub struct WorkspaceTabs {
    pub tabs: Vec<String>,
    pub preview: Option<String>,
    pub active: Option<String>,
}

/// Path of a workspace's ui.json inside its state dir. `canonical_root` must
/// already be canonical (ensure_root's return) so symlink/alias variants of
/// one root collapse to a single state dir — the same keying as history.rs's
/// buckets (`bucket_key` is that module's hashing helper, reused here).
pub(crate) fn ui_state_file(base: &Path, canonical_root: &str) -> std::path::PathBuf {
    base.join("workspace-state")
        .join(crate::history::bucket_key(canonical_root))
        .join("ui.json")
}

/// Atomically replace the stored tab set (v2), creating the state dir on first
/// write. Every path is stored verbatim: the LOAD side owns the validation
/// (containment + existence), which is the trust boundary — a stored path that
/// never validates only ever buys the caller a dropped row, never an escape.
pub(crate) fn save_ui_state(
    file: &Path,
    tabs: &[String],
    preview: Option<&str>,
    active: Option<&str>,
) -> Result<(), String> {
    let state = UiStateV2 {
        version: 2,
        tabs: tabs.to_vec(),
        preview: preview.map(str::to_string),
        active: active.map(str::to_string),
    };
    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    if json.len() as u64 > MAX_UI_STATE_BYTES {
        return Err("workspace ui state too large".into());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::history::atomic_write(file, json.as_bytes()).map_err(|e| e.to_string())
}

/// Validate one stored path as a live child of `canonical_root`: it must
/// canonicalize to an existing regular file STRICTLY inside the root
/// (`starts_with` is component-wise and the root itself is excluded —
/// `resolve_image_under`'s containment posture), so a tampered ui.json can
/// never point a restored row outside the workspace, and a deleted/moved path
/// drops to `None`. Returns the canonical path, which — being strictly inside
/// a granted root — passes `AllowedPaths::ensure` for the read that follows.
fn valid_child(path: &str, canonical_root: &Path) -> Option<String> {
    let canon = fs::canonicalize(path).ok()?;
    if !canon.is_file() || !canon.starts_with(canonical_root) || canon == canonical_root {
        return None;
    }
    canon.to_str().map(str::to_string)
}

/// Read the stored tab set. Tolerant on the FILE — missing, oversized, or
/// corrupt yields `None`, mirroring `load_state` — but strict on every VALUE:
/// each path (every tab, the preview, the active) is validated through
/// [`valid_child`], and any that no longer validates is silently dropped, so a
/// stale/tampered entry degrades to a dropped row instead of breaking the
/// rest. A v1 `{lastFile}` file migrates to `active = lastFile`, no tabs.
/// Surviving `tabs` are deduped (canonicalized); the `preview` is dropped if
/// it collides with a surviving tab (a preview is never in the pinned list).
/// Returns `None` when nothing survives (empty tabs + no preview + no active),
/// preserving the frontend's "null means restore nothing" contract.
pub(crate) fn load_ui_state(file: &Path, canonical_root: &Path) -> Option<WorkspaceTabs> {
    let meta = fs::metadata(file).ok()?;
    if meta.len() > MAX_UI_STATE_BYTES {
        return None;
    }
    let raw = fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let (raw_tabs, raw_preview, raw_active) = match value.get("version").and_then(|v| v.as_u64()) {
        Some(2) => {
            let s: UiStateV2 = serde_json::from_value(value).ok()?;
            (s.tabs, s.preview, s.active)
        }
        Some(1) => {
            let s: UiStateV1 = serde_json::from_value(value).ok()?;
            (Vec::new(), None, Some(s.last_file))
        }
        _ => return None,
    };

    let mut tabs: Vec<String> = Vec::new();
    for p in raw_tabs {
        if let Some(canon) = valid_child(&p, canonical_root) {
            if !tabs.contains(&canon) {
                tabs.push(canon);
            }
        }
    }
    // A surviving preview must not duplicate a pinned row (never in openList).
    let preview = raw_preview
        .and_then(|p| valid_child(&p, canonical_root))
        .filter(|c| !tabs.contains(c));
    // `active` may legitimately equal one of the tabs (or the preview).
    let active = raw_active.and_then(|p| valid_child(&p, canonical_root));

    if tabs.is_empty() && preview.is_none() && active.is_none() {
        return None;
    }
    Some(WorkspaceTabs {
        tabs,
        preview,
        active,
    })
}

/// Persist `root`'s open-tab set. `root` must be a granted workspace root
/// (`ensure_root`, like `list_workspace`) — the webview cannot use this
/// command to write state for arbitrary directories. The paths are not
/// validated here; see `save_ui_state` (LOAD owns the trust boundary).
#[tauri::command]
pub fn save_workspace_ui(
    root: String,
    tabs: Vec<String>,
    preview: Option<String>,
    active: Option<String>,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<(), String> {
    let canon = allowed.ensure_root(&root)?;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = ui_state_file(&base, &canon.to_string_lossy());
    save_ui_state(&file, &tabs, preview.as_deref(), active.as_deref())
}

/// The workspace's remembered tab set, or `None` when nothing is stored or no
/// entry still validates (vanished files, tampered state, paths outside the
/// root — see `load_ui_state`). Same `ensure_root` gate as `save_workspace_ui`.
#[tauri::command]
pub fn load_workspace_ui(
    root: String,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Option<WorkspaceTabs>, String> {
    let canon = allowed.ensure_root(&root)?;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = ui_state_file(&base, &canon.to_string_lossy());
    Ok(load_ui_state(&file, &canon))
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
    fn recent_roots_reads_the_mru_newest_first_and_tolerates_a_missing_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        assert!(recent_roots(&file).is_empty(), "missing file: empty list");
        persist_open(&file, "/ws/a").unwrap();
        persist_open(&file, "/ws/b").unwrap();
        assert_eq!(recent_roots(&file), vec!["/ws/b", "/ws/a"]);
        // Corrupt state degrades to empty, mirroring load_state's tolerance.
        fs::write(&file, "not json at all").unwrap();
        assert!(recent_roots(&file).is_empty());
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

    // -- per-workspace UI state (the open-tab set) ---------------------------

    /// A canonical workspace root with one real markdown file inside, plus a
    /// state base dir — the fixtures every ui-state test needs. Roots are
    /// canonicalized up front (macOS tempdirs live under the /var -> /private
    /// symlink) so containment compares canonical to canonical, exactly as
    /// the commands do via `ensure_root`.
    fn ui_fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(mkdir(dir.path(), "ws")).unwrap();
        let note = root.join("note.md");
        fs::write(&note, "# note").unwrap();
        (dir, root, note)
    }

    fn mkdir(base: &Path, name: &str) -> std::path::PathBuf {
        let p = base.join(name);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Create a real markdown file `name` inside `root` and return its path
    /// (as an owned String, the shape `save_ui_state`'s `tabs` slice wants).
    fn mkfile(root: &Path, name: &str) -> String {
        let p = root.join(name);
        fs::write(&p, "x").unwrap();
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn ui_state_v2_round_trips_the_whole_tab_set() {
        let (base, root, note) = ui_fixture();
        let other = mkfile(&root, "other.md");
        let glance = mkfile(&root, "glance.md");
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        let tabs = vec![note.to_str().unwrap().to_string(), other.clone()];
        save_ui_state(&file, &tabs, Some(&glance), Some(&other)).unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, tabs, "pinned rows kept in strip order");
        assert_eq!(loaded.preview.as_deref(), Some(glance.as_str()));
        assert_eq!(loaded.active.as_deref(), Some(other.as_str()));
        // The stored shape is the documented {"version":2,tabs,preview,active}.
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"version\":2"));
        assert!(raw.contains("\"tabs\""));
    }

    #[test]
    fn ui_state_migrates_v1_lastfile_to_active() {
        // A pre-tab-set {"version":1,"lastFile":…} file must surface its file
        // as the restored active doc, with no pinned tabs — never silently
        // parse to empty and lose the restore.
        let (base, root, note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            format!(
                "{{\"version\":1,\"lastFile\":\"{}\"}}",
                note.to_str().unwrap()
            ),
        )
        .unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert!(loaded.tabs.is_empty(), "v1 has no pinned tabs");
        assert_eq!(loaded.active.as_deref(), Some(note.to_str().unwrap()));
        assert_eq!(loaded.preview, None);
    }

    #[test]
    fn ui_state_drops_a_stale_tab_keeping_the_valid_one() {
        // The data-loss guard: one vanished + one live tab must load as just
        // the live one, not fail the whole restore.
        let (base, root, note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        let gone = root.join("gone.md").to_str().unwrap().to_string();
        let tabs = vec![note.to_str().unwrap().to_string(), gone];
        save_ui_state(&file, &tabs, None, None).unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, vec![note.to_str().unwrap().to_string()]);
    }

    #[test]
    fn ui_state_dedupes_repeated_tabs() {
        let (base, root, note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        let n = note.to_str().unwrap().to_string();
        save_ui_state(&file, &[n.clone(), n.clone()], None, None).unwrap();
        assert_eq!(load_ui_state(&file, &root).unwrap().tabs, vec![n]);
    }

    #[test]
    fn ui_state_missing_or_corrupt_file_is_none() {
        let (base, root, _note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        assert_eq!(load_ui_state(&file, &root), None, "missing file");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "not json at all").unwrap();
        assert_eq!(load_ui_state(&file, &root), None, "corrupt file");
    }

    #[test]
    fn ui_state_drops_paths_outside_the_root() {
        // Containment is the trust boundary: a tampered ui.json naming files
        // outside the workspace must drop them, never open outside the root.
        let (base, root, note) = ui_fixture();
        let outside = base.path().join("secret.md");
        fs::write(&outside, "top secret").unwrap();
        let outside_canon = fs::canonicalize(&outside)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        // The outside path is dropped from tabs, preview, and active alike; the
        // one valid tab survives.
        save_ui_state(
            &file,
            &[note.to_str().unwrap().to_string(), outside_canon.clone()],
            Some(&outside_canon),
            Some(&outside_canon),
        )
        .unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, vec![note.to_str().unwrap().to_string()]);
        assert_eq!(loaded.preview, None);
        assert_eq!(loaded.active, None);
    }

    #[test]
    fn ui_state_rejects_a_sibling_sharing_the_root_as_string_prefix() {
        // starts_with is component-wise: /…/ws-evil never counts as inside /…/ws.
        let (base, root, _note) = ui_fixture();
        let evil = mkdir(base.path(), "ws-evil");
        let f = evil.join("x.md");
        fs::write(&f, "x").unwrap();
        let f_canon = fs::canonicalize(&f).unwrap().to_str().unwrap().to_string();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, &[f_canon], None, None).unwrap();
        assert_eq!(load_ui_state(&file, &root), None);
    }

    #[test]
    fn ui_state_drops_a_preview_that_collides_with_a_surviving_tab() {
        // A preview is never in the pinned list; if a tampered file lists the
        // same path as both, the preview is dropped and the tab kept.
        let (base, root, note) = ui_fixture();
        let n = note.to_str().unwrap().to_string();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, std::slice::from_ref(&n), Some(&n), None).unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, vec![n]);
        assert_eq!(loaded.preview, None);
    }

    #[test]
    fn ui_state_active_may_equal_a_tab() {
        // active is the file showing in the editor — legitimately one of the
        // pinned tabs, so it is NOT filtered against them.
        let (base, root, note) = ui_fixture();
        let n = note.to_str().unwrap().to_string();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, std::slice::from_ref(&n), None, Some(&n)).unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, vec![n.clone()]);
        assert_eq!(loaded.active.as_deref(), Some(n.as_str()));
    }

    #[test]
    fn ui_state_whole_empty_state_loads_as_none() {
        // Every entry vanished (or none stored): load returns None so the
        // frontend's null-means-restore-nothing contract holds.
        let (base, root, _note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        let gone = root.join("gone.md").to_str().unwrap().to_string();
        save_ui_state(&file, std::slice::from_ref(&gone), Some(&gone), Some(&gone)).unwrap();
        assert_eq!(load_ui_state(&file, &root), None);
    }

    #[test]
    fn ui_state_overwrite_is_last_writer_wins() {
        let (base, root, note) = ui_fixture();
        let other = mkfile(&root, "other.md");
        let n = note.to_str().unwrap().to_string();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, std::slice::from_ref(&other), None, None).unwrap();
        save_ui_state(&file, std::slice::from_ref(&n), None, Some(&n)).unwrap();
        let loaded = load_ui_state(&file, &root).unwrap();
        assert_eq!(loaded.tabs, vec![n.clone()]);
        assert_eq!(loaded.active.as_deref(), Some(n.as_str()));
    }

    #[test]
    fn ui_state_rejects_the_root_itself_and_directories() {
        let (base, root, _note) = ui_fixture();
        let sub = mkdir(&root, "sub");
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, &[root.to_str().unwrap().to_string()], None, None).unwrap();
        assert_eq!(load_ui_state(&file, &root), None, "the root is not a file");
        save_ui_state(&file, &[sub.to_str().unwrap().to_string()], None, None).unwrap();
        assert_eq!(
            load_ui_state(&file, &root),
            None,
            "a directory is not openable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ui_state_rejects_a_symlink_escaping_the_root() {
        // Same posture as AllowedPaths::ensure: canonicalize resolves the
        // link, landing outside the root, so containment fails closed.
        let (base, root, _note) = ui_fixture();
        let secret = base.path().join("secret.md");
        fs::write(&secret, "top secret").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        save_ui_state(&file, &[link.to_str().unwrap().to_string()], None, None).unwrap();
        assert_eq!(load_ui_state(&file, &root), None);
    }

    #[test]
    fn ui_state_files_are_scoped_per_workspace() {
        // Two roots never share a ui.json: the state dir is keyed by the
        // hashed canonical root (history.rs's bucket_key).
        let (base, root_a, note_a) = ui_fixture();
        let root_b = fs::canonicalize(mkdir(base.path(), "ws2")).unwrap();
        let file_a = ui_state_file(base.path(), root_a.to_str().unwrap());
        let file_b = ui_state_file(base.path(), root_b.to_str().unwrap());
        assert_ne!(file_a, file_b);
        save_ui_state(&file_a, &[note_a.to_str().unwrap().to_string()], None, None).unwrap();
        assert_eq!(
            load_ui_state(&file_b, &root_b),
            None,
            "workspace b has no state"
        );
    }

    #[test]
    fn ui_state_oversized_file_is_none_and_oversized_save_rejects() {
        let (base, root, _note) = ui_fixture();
        let file = ui_state_file(base.path(), root.to_str().unwrap());
        let huge = "x".repeat(MAX_UI_STATE_BYTES as usize + 1);
        assert!(
            save_ui_state(&file, std::slice::from_ref(&huge), None, None).is_err(),
            "oversized save rejects"
        );
        // A file inflated out-of-band is ignored on read rather than parsed.
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, format!("{{\"version\":2,\"tabs\":[\"{huge}\"]}}")).unwrap();
        assert_eq!(load_ui_state(&file, &root), None);
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
