use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_mini::{DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, EventTarget, State, WebviewWindow};

/// Per-window file watchers, keyed by webview label. In MODE B (multi-window)
/// two windows can watch two different files at once; keying by label means one
/// window replacing/stopping its watcher never clobbers another window's.
/// Dropping a `RecommendedWatcher` (via `remove`/`set`) stops its background
/// thread.
///
/// Poison policy: the inner `Mutex` is `unwrap()`'d on poison deliberately —
/// see the central note on `crate::OpenedFiles`.
#[derive(Default)]
pub struct FileWatcher(Mutex<HashMap<String, RecommendedWatcher>>);

impl FileWatcher {
    /// Install (or replace) the watcher for `label`. Replacing drops the prior
    /// `RecommendedWatcher`, stopping its background thread; only this label's
    /// slot is touched, so other windows' watchers are untouched.
    pub fn set(&self, label: String, watcher: RecommendedWatcher) {
        self.0.lock().unwrap().insert(label, watcher);
    }

    /// Drop `label`'s watcher, if any (stopping its thread). Removing by label
    /// leaves every other window's watcher in place. No-op when absent.
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

/// Per-window recursive workspace-root watchers, keyed by webview label like
/// `FileWatcher`. Dropping a `Debouncer` (via `remove`/`set`) stops both its
/// debounce thread and the inner watcher, so replace-on-set gives
/// workspace-switch semantics and remove gives close-folder semantics for free.
///
/// Poison policy: the inner `Mutex` is `unwrap()`'d on poison deliberately —
/// see the central note on `crate::OpenedFiles`.
#[derive(Default)]
pub struct WorkspaceWatcher(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

impl WorkspaceWatcher {
    /// Install (or replace) the watcher for `label`. Replacing drops the prior
    /// `Debouncer`, stopping its threads; only this label's slot is touched.
    pub fn set(&self, label: String, debouncer: Debouncer<RecommendedWatcher>) {
        self.0.lock().unwrap().insert(label, debouncer);
    }

    /// Drop `label`'s watcher, if any (stopping its threads). No-op when absent.
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

/// Whether a debounced event batch touches anything the workspace tree could
/// display: true when any path, relative to `root`, has NO component starting
/// with '.'. This drops `.git/index` churn (`git status` in a terminal would
/// otherwise refresh the sidebar every 500ms) while a real checkout still
/// fires via its working-tree paths — consistent with workspace.rs's walk,
/// which skips dot-entries, so a dot-only change could never alter the tree.
/// Paths that fail `strip_prefix` (outside the root somehow) and the root
/// itself both count as concerning: fail toward refreshing.
fn concerns_workspace(root: &Path, paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| match p.strip_prefix(root) {
        Err(_) => true,
        Ok(rel) => !rel
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
    })
}

/// Watch the workspace root recursively, emitting one coalesced (500ms
/// debounce) `workspace:changed` event to the calling window per burst of FS
/// activity, so external changes (git checkout, `mv`, another app saving)
/// refresh the sidebar without waiting for a window refocus. Replaces only
/// THIS window's previous root watch (workspace switch).
///
/// `window` is injected by Tauri (not supplied by the webview), so the label is
/// always the real calling window.
#[tauri::command]
pub fn watch_workspace(
    root: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, WorkspaceWatcher>,
    allowed: State<'_, crate::allowlist::AllowedPaths>,
) -> Result<(), String> {
    // Same gate as list_workspace: only an actual granted workspace root.
    // Deliberately NOT reject_unsafe_path'd: the root passed back here is
    // Rust's own canonical output, which on Windows carries the `\\?\`
    // verbatim prefix that guard rejects (see history.rs's module doc), and
    // ensure_root already requires exact membership in the canonicalized
    // granted-root set — an ungranted UNC/device path can never pass it.
    let canon = allowed.ensure_root(&root)?;

    let label = window.label().to_string();
    // Owned copies for the debounce callback (runs on the debouncer's thread).
    let cb_label = label.clone();
    let cb_root = canon.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
                if concerns_workspace(&cb_root, &paths) {
                    // Route to the owning window only; the label ALSO rides in
                    // the payload so listenScoped can defensively drop a
                    // delivery that leaked to the wrong webview.
                    let _ = app.emit_to(
                        EventTarget::webview_window(&cb_label),
                        "workspace:changed",
                        serde_json::json!({ "target": cb_label }),
                    );
                }
            }
            // Watcher errors fail open: the focus/doc-change refresh paths
            // still exist, so log and keep going rather than surface a banner.
            Err(e) => log::warn!("workspace watcher error: {e}"),
        },
    )
    // notify's error Display can echo the watched path; never surface that
    // to the webview/IPC. Log the real error server-side, return a fixed
    // message instead (mirrors watch_file).
    .map_err(|e| {
        log::warn!("could not create workspace watcher for {root}: {e}");
        "could not watch workspace for changes".to_string()
    })?;

    debouncer
        .watcher()
        .watch(&canon, RecursiveMode::Recursive)
        .map_err(|e| {
            log::warn!(
                "could not watch {} for workspace changes: {e}",
                canon.display()
            );
            "could not watch workspace for changes".to_string()
        })?;

    // Replaces only this window's slot; other windows' watchers are untouched.
    state.set(label, debouncer);
    Ok(())
}

/// Stop watching the calling window's workspace root, if any (close folder).
/// Removing by label leaves every other window's watcher in place.
#[tauri::command]
pub fn unwatch_workspace(window: WebviewWindow, state: State<'_, WorkspaceWatcher>) {
    state.remove(window.label());
}

/// Watch `path` for external modifications, emitting `file:external-change` to
/// the calling window (via `emit_to(label)`) when the file changes on disk.
/// Replaces only THIS window's previously watched file.
///
/// The parent directory is watched (non-recursively) rather than the file
/// itself, so atomic rename-replace saves (used by many editors) are still
/// detected; events are then filtered down to the target file name.
///
/// `window` is injected by Tauri (not supplied by the webview), so the label is
/// always the real calling window.
#[tauri::command]
pub fn watch_file(
    path: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, FileWatcher>,
    allowed: State<'_, crate::allowlist::AllowedPaths>,
) -> Result<(), String> {
    allowed.ensure(&path)?;
    // Same UNC/device-path guard the read/write commands apply (defense-in-depth;
    // keeps every path entry point consistent even if callers change).
    crate::commands::reject_unsafe_path(&path)?;

    let target = std::path::PathBuf::from(&path);
    let target_name = target.file_name().map(|n| n.to_os_string());
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "path has no parent directory".to_string())?;

    let label = window.label().to_string();
    // Owned copy for the notify callback (runs on the watcher's own thread).
    let cb_label = label.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
            return;
        }
        let concerns_target = event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n.to_os_string()) == target_name);
        if concerns_target {
            // Route to the owning window only. The target label is ALSO carried
            // in the payload so the frontend can defensively drop a delivery
            // that leaked to the wrong webview.
            let _ = app.emit_to(
                EventTarget::webview_window(&cb_label),
                "file:external-change",
                serde_json::json!({ "target": cb_label }),
            );
        }
    })
    // notify's error Display can echo the watched path; never surface that
    // to the webview/IPC. Log the real error server-side, return a fixed
    // message instead (mirrors fileops::delete_entries_impl's trash mapping).
    .map_err(|e| {
        log::warn!("could not create file watcher for {path}: {e}");
        "could not watch file for external changes".to_string()
    })?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| {
            log::warn!(
                "could not watch {} for external changes: {e}",
                dir.display()
            );
            "could not watch file for external changes".to_string()
        })?;

    // Replaces only this window's slot; other windows' watchers are untouched.
    state.set(label, watcher);
    Ok(())
}

/// Stop watching the calling window's current file, if any. Removing by label
/// leaves every other window's watcher in place.
#[tauri::command]
pub fn unwatch(window: WebviewWindow, state: State<'_, FileWatcher>) {
    state.remove(window.label());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_watcher() -> RecommendedWatcher {
        notify::recommended_watcher(|_res: notify::Result<notify::Event>| {}).unwrap()
    }

    #[test]
    fn watchers_are_isolated_per_label() {
        // The core MODE B invariant: two windows watching two files coexist,
        // and one window's unwatch (a `remove` by label) never drops another's.
        // Mutations go through the accessors (set/remove); the isolation
        // assertions read the in-module private map (no query accessor exists).
        let fw = FileWatcher::default();
        fw.set("main".into(), dummy_watcher());
        fw.set("doc-1".into(), dummy_watcher());
        assert_eq!(fw.0.lock().unwrap().len(), 2);

        // Simulate unwatch("main").
        fw.remove("main");
        assert!(!fw.0.lock().unwrap().contains_key("main"));
        assert!(
            fw.0.lock().unwrap().contains_key("doc-1"),
            "removing one window's watcher must leave the other's intact"
        );
    }

    #[test]
    fn reinserting_same_label_replaces_only_that_slot() {
        let fw = FileWatcher::default();
        fw.set("doc-1".into(), dummy_watcher());
        fw.set("doc-2".into(), dummy_watcher());
        // watch_file for doc-1 again replaces doc-1's watcher, keeps doc-2.
        fw.set("doc-1".into(), dummy_watcher());
        assert_eq!(fw.0.lock().unwrap().len(), 2);
        assert!(fw.0.lock().unwrap().contains_key("doc-2"));
    }

    fn dummy_debouncer() -> Debouncer<RecommendedWatcher> {
        notify_debouncer_mini::new_debouncer(
            Duration::from_millis(500),
            |_res: DebounceEventResult| {},
        )
        .unwrap()
    }

    #[test]
    fn workspace_watchers_are_isolated_per_label() {
        // Same MODE B invariant as FileWatcher: one window's unwatch_workspace
        // (a `remove` by label) never drops another window's root watch.
        let ww = WorkspaceWatcher::default();
        ww.set("main".into(), dummy_debouncer());
        ww.set("doc-1".into(), dummy_debouncer());
        assert_eq!(ww.0.lock().unwrap().len(), 2);

        ww.remove("main");
        assert!(!ww.0.lock().unwrap().contains_key("main"));
        assert!(
            ww.0.lock().unwrap().contains_key("doc-1"),
            "removing one window's workspace watcher must leave the other's intact"
        );
    }

    #[test]
    fn workspace_reinserting_same_label_replaces_only_that_slot() {
        // watch_workspace on a root switch replaces this window's slot
        // (dropping the old Debouncer, i.e. the old root's watch), keeps others.
        let ww = WorkspaceWatcher::default();
        ww.set("doc-1".into(), dummy_debouncer());
        ww.set("doc-2".into(), dummy_debouncer());
        ww.set("doc-1".into(), dummy_debouncer());
        assert_eq!(ww.0.lock().unwrap().len(), 2);
        assert!(ww.0.lock().unwrap().contains_key("doc-2"));
    }

    #[test]
    fn concerns_workspace_drops_dot_only_batches() {
        // `.git/index` churn (git status) must not refresh the sidebar.
        let root = Path::new("/ws");
        assert!(!concerns_workspace(
            root,
            &[PathBuf::from("/ws/.git/index")]
        ));
        // Dot-component anywhere in the relative path hides the change too.
        assert!(!concerns_workspace(
            root,
            &[PathBuf::from("/ws/sub/.cache/x")]
        ));
    }

    #[test]
    fn concerns_workspace_fires_on_visible_paths() {
        let root = Path::new("/ws");
        assert!(concerns_workspace(
            root,
            &[PathBuf::from("/ws/sub/notes.md")]
        ));
        // A mixed batch (real checkout: .git churn + working-tree paths) fires.
        assert!(concerns_workspace(
            root,
            &[
                PathBuf::from("/ws/.git/index"),
                PathBuf::from("/ws/notes.md")
            ]
        ));
    }

    #[test]
    fn concerns_workspace_fails_open_on_root_and_foreign_paths() {
        let root = Path::new("/ws");
        // The root itself (empty relative path) refreshes.
        assert!(concerns_workspace(root, &[PathBuf::from("/ws")]));
        // A path outside the root (strip_prefix fails) fails toward refreshing.
        assert!(concerns_workspace(
            root,
            &[PathBuf::from("/elsewhere/a.md")]
        ));
    }
}
