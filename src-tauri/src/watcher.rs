use std::collections::HashMap;
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, EventTarget, State, WebviewWindow};

/// Per-window file watchers, keyed by webview label. In MODE B (multi-window)
/// two windows can watch two different files at once; keying by label means one
/// window replacing/stopping its watcher never clobbers another window's.
/// Dropping a `RecommendedWatcher` (via `remove`/`insert`) stops its background
/// thread.
#[derive(Default)]
pub struct FileWatcher(pub Mutex<HashMap<String, RecommendedWatcher>>);

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
            // that leaked to the wrong webview (amendment wave6 #8).
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
    state.0.lock().unwrap().insert(label, watcher);
    Ok(())
}

/// Stop watching the calling window's current file, if any. Removing by label
/// leaves every other window's watcher in place.
#[tauri::command]
pub fn unwatch(window: WebviewWindow, state: State<'_, FileWatcher>) {
    state.0.lock().unwrap().remove(window.label());
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
        let fw = FileWatcher::default();
        {
            let mut m = fw.0.lock().unwrap();
            m.insert("main".into(), dummy_watcher());
            m.insert("doc-1".into(), dummy_watcher());
        }
        assert_eq!(fw.0.lock().unwrap().len(), 2);

        // Simulate unwatch("main").
        fw.0.lock().unwrap().remove("main");
        assert!(!fw.0.lock().unwrap().contains_key("main"));
        assert!(
            fw.0.lock().unwrap().contains_key("doc-1"),
            "removing one window's watcher must leave the other's intact"
        );
    }

    #[test]
    fn reinserting_same_label_replaces_only_that_slot() {
        let fw = FileWatcher::default();
        {
            let mut m = fw.0.lock().unwrap();
            m.insert("doc-1".into(), dummy_watcher());
            m.insert("doc-2".into(), dummy_watcher());
        }
        // watch_file for doc-1 again replaces doc-1's watcher, keeps doc-2.
        fw.0.lock().unwrap().insert("doc-1".into(), dummy_watcher());
        assert_eq!(fw.0.lock().unwrap().len(), 2);
        assert!(fw.0.lock().unwrap().contains_key("doc-2"));
    }
}
