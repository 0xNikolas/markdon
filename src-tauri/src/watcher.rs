use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// Holds the single active file watcher. Replacing the `Option` (or setting it to
/// `None`) drops the previous watcher, which stops its background thread.
#[derive(Default)]
pub struct FileWatcher(pub Mutex<Option<RecommendedWatcher>>);

/// Watch `path` for external modifications, emitting `file:external-change` to the
/// frontend when the file changes on disk. Replaces any previously watched file.
///
/// The parent directory is watched (non-recursively) rather than the file itself,
/// so atomic rename-replace saves (used by many editors) are still detected; events
/// are then filtered down to the target file name.
#[tauri::command]
pub fn watch_file(
  path: String,
  app: AppHandle,
  state: State<'_, FileWatcher>,
) -> Result<(), String> {
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

  let mut watcher =
    notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
      let Ok(event) = res else { return };
      if !matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
        return;
      }
      let concerns_target = event
        .paths
        .iter()
        .any(|p| p.file_name().map(|n| n.to_os_string()) == target_name);
      if concerns_target {
        let _ = app.emit("file:external-change", ());
      }
    })
    .map_err(|e| e.to_string())?;

  watcher
    .watch(&dir, RecursiveMode::NonRecursive)
    .map_err(|e| e.to_string())?;

  *state.0.lock().unwrap() = Some(watcher);
  Ok(())
}

/// Stop watching the current file, if any.
#[tauri::command]
pub fn unwatch(state: State<'_, FileWatcher>) {
  *state.0.lock().unwrap() = None;
}
