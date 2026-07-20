use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::allowlist::AllowedPaths;

#[derive(Serialize)]
pub struct OpenedFile {
  pub path: String,
  pub content: String,
}

fn to_path_string(file: tauri_plugin_dialog::FilePath) -> Result<String, String> {
  file
    .into_path()
    .map_err(|e| e.to_string())?
    .to_str()
    .map(str::to_string)
    .ok_or_else(|| "non-UTF-8 path".to_string())
}

/// Show the open dialog, read the picked file, and grant the webview access to
/// it. Returns `None` if the user cancelled. Dialogs live in Rust so the
/// allowlist can only ever contain user-picked paths.
#[tauri::command]
pub async fn open_file_dialog(
  app: AppHandle,
  allowed: State<'_, AllowedPaths>,
) -> Result<Option<OpenedFile>, String> {
  let picked = tauri::async_runtime::spawn_blocking(move || {
    app
      .dialog()
      .file()
      .add_filter("Markdown", &["md", "markdown"])
      .blocking_pick_file()
  })
  .await
  .map_err(|e| e.to_string())?;
  let Some(file) = picked else { return Ok(None) };
  let path = to_path_string(file)?;
  let content = crate::commands::read_file_impl(&path)?;
  allowed.allow(&path);
  Ok(Some(OpenedFile { path, content }))
}

/// Show the save dialog and grant the webview access to the chosen path.
/// Returns `None` if the user cancelled. The frontend then calls `write_file`.
#[tauri::command]
pub async fn save_file_dialog(
  default_path: Option<String>,
  app: AppHandle,
  allowed: State<'_, AllowedPaths>,
) -> Result<Option<String>, String> {
  let picked = tauri::async_runtime::spawn_blocking(move || {
    let mut b = app
      .dialog()
      .file()
      .add_filter("Markdown", &["md", "markdown"]);
    if let Some(p) = default_path {
      let pb = std::path::PathBuf::from(&p);
      if let Some(dir) = pb.parent().filter(|d| !d.as_os_str().is_empty()) {
        b = b.set_directory(dir);
      }
      if let Some(name) = pb.file_name().and_then(|n| n.to_str()) {
        b = b.set_file_name(name);
      }
    }
    b.blocking_save_file()
  })
  .await
  .map_err(|e| e.to_string())?;
  let Some(file) = picked else { return Ok(None) };
  let path = to_path_string(file)?;
  allowed.allow(&path);
  Ok(Some(path))
}
