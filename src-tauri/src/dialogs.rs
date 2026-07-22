use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::allowlist::AllowedPaths;
use crate::workspace::Workspace;

#[derive(Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub content: String,
}

/// A named save-dialog filter (e.g. "HTML" -> ["html"]). Export uses this to
/// pick an HTML or Markdown filter; omitting it keeps the historical
/// Markdown-only behavior.
#[derive(Deserialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// None or empty means the historical default: Markdown.
fn effective_filters(filters: Option<Vec<FileFilter>>) -> Vec<FileFilter> {
    match filters {
        Some(f) if !f.is_empty() => f,
        _ => vec![FileFilter {
            name: "Markdown".into(),
            extensions: vec!["md".into(), "markdown".into()],
        }],
    }
}

fn to_path_string(file: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    file.into_path()
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
        app.dialog()
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
/// `filters` lets callers (export) pick a non-Markdown filter; omitting it
/// (existing `saveAs()` callers) behaves identically to before.
#[tauri::command]
pub async fn save_file_dialog(
    default_path: Option<String>,
    filters: Option<Vec<FileFilter>>,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file();
        for f in effective_filters(filters) {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            b = b.add_filter(f.name, &exts);
        }
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

/// Show the folder picker and grant the webview a DIRECTORY-scoped allowlist
/// root for the chosen folder. Returns `None` if the user cancelled. Every file
/// strictly inside the granted root then passes `ensure`; the root itself does
/// not. Persists the pick so it can be restored next launch.
#[tauri::command]
pub async fn open_workspace_dialog(
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Option<Workspace>, String> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = to_path_string(folder)?;
    let canon = allowed.allow_root(std::path::Path::new(&path))?;
    Ok(Some(crate::workspace::open_result(&app, &canon)?))
}

/// Show the folder picker and, on a pick, hand the folder to a brand-NEW app
/// process (`current_exe --workspace <dir>`) instead of adopting it here. Used
/// when this instance already has a workspace open — VS Code semantics: a
/// second folder gets its own instance. Deliberately no grant / no persist /
/// no walk in THIS process: the child's argv parsing + `take_startup_workspace`
/// do all of that in its own allowlist, and skipping persistence keeps the two
/// instances from clobbering each other's restore pointer. Returns whether a
/// folder was actually picked (false = cancelled), so the frontend can skip
/// any "opened" UI on cancel. Dropping the spawned Child handle would NOT
/// detach it — the exited child would linger as a zombie until waited on — so
/// a throwaway thread reaps it; the thread never influences the child's
/// lifetime.
#[tauri::command]
pub async fn pick_folder_new_instance(app: AppHandle) -> Result<bool, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| e.to_string())?;
    let Some(folder) = picked else {
        return Ok(false);
    };
    let path = to_path_string(folder)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = std::process::Command::new(exe)
        .args(["--workspace", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_filters_none_defaults_to_markdown() {
        let f = effective_filters(None);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].name, "Markdown");
        assert_eq!(f[0].extensions, vec!["md", "markdown"]);
    }

    #[test]
    fn effective_filters_empty_defaults_to_markdown() {
        let f = effective_filters(Some(vec![]));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].name, "Markdown");
        assert_eq!(f[0].extensions, vec!["md", "markdown"]);
    }

    #[test]
    fn effective_filters_passes_through_a_provided_filter() {
        let f = effective_filters(Some(vec![FileFilter {
            name: "HTML".into(),
            extensions: vec!["html".into()],
        }]));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].name, "HTML");
        assert_eq!(f[0].extensions, vec!["html"]);
    }

    #[test]
    fn file_filter_deserializes_from_json() {
        let f: FileFilter = serde_json::from_str(r#"{"name":"HTML","extensions":["html"]}"#)
            .expect("FileFilter should deserialize");
        assert_eq!(f.name, "HTML");
        assert_eq!(f.extensions, vec!["html"]);
    }
}
