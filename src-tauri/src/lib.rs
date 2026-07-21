mod allowlist;
mod commands;
mod dialogs;
mod fileops;
mod history;
mod menu;
mod pdf;
mod watcher;
mod workspace;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Buffer of file paths macOS asked us to open (via Finder double-click / `open`).
/// Needed because on a cold launch the OS delivers the file before the webview's
/// JS listeners exist, so we stash paths here until the frontend drains them.
#[derive(Default)]
pub struct OpenedFiles(pub Mutex<Vec<String>>);

/// The label of the window that currently has focus, self-tracked from
/// `WindowEvent::Focused(true)` (the stable API — `get_focused_window()` is gated
/// behind Tauri's `unstable` feature, deliberately avoided). MODE B routes app-
/// global macOS menu commands to this window, since an app menu bar carries no
/// window identity of its own.
#[derive(Default)]
pub struct FocusedWindow(pub Mutex<Option<String>>);

/// Files assigned to a spawned document window but not yet consumed by it. The
/// spawner stashes `label -> path` here; the new window's frontend drains its own
/// entry on mount via `take_window_file`.
#[derive(Default)]
pub struct PendingWindowFile(pub Mutex<HashMap<String, String>>);

/// Monotonic counter for spawned-window labels (`doc-1`, `doc-2`, …). The
/// `doc-*` prefix is load-bearing: capabilities/default.json grants the default
/// permission set to `doc-*`, so any future spawned window MUST keep this prefix
/// or it will silently lack IPC/event permissions.
static NEXT_WIN: AtomicU64 = AtomicU64::new(1);

/// Which window label should receive an app-global menu command: the focused
/// one, falling back to `main` when nothing is tracked as focused (e.g. a menu
/// clicked while a native dialog owns focus). Pure so it is unit-testable
/// without a GUI.
fn menu_target(focused: &Option<String>) -> String {
    focused.clone().unwrap_or_else(|| "main".into())
}

/// Per-window setup applied to BOTH the config `main` window and every spawned
/// `doc-*` window: self-tracks focus into `FocusedWindow`, and handles close
/// requests per-window (routing `window:close-requested` to the closing window
/// only, so one window's close prompt never fires in another).
fn wire_window(window: &WebviewWindow, app: &AppHandle) {
    let label = window.label().to_string();

    // Seed focus on creation so a menu command issued before the first
    // Focused(true) event still has a best-effort target.
    if window.is_focused().unwrap_or(false) {
        *app.state::<FocusedWindow>().0.lock().unwrap() = Some(label.clone());
    }

    let app_focus = app.clone();
    let lbl_focus = label.clone();
    let app_close = app.clone();
    let lbl_close = label;
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(true) => {
            *app_focus.state::<FocusedWindow>().0.lock().unwrap() = Some(lbl_focus.clone());
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            // Belt-and-braces: the plugin normally persists on RunEvent::Exit,
            // which still fires after the frontend calls window.destroy(), but
            // saving here makes persistence independent of exit handling.
            #[cfg(desktop)]
            let _ = app_close.save_window_state(StateFlags::all());
            // Route to the closing window ONLY (+ carry its label in the payload
            // as defensive insurance the frontend can filter on).
            let _ = app_close.emit_to(
                EventTarget::webview_window(&lbl_close),
                "window:close-requested",
                serde_json::json!({ "target": lbl_close }),
            );
        }
        _ => {}
    });
}

/// Drain and return any pending file-open paths. The frontend calls this on mount
/// (cold start) and whenever a `file:opened` event fires (already-running app).
/// Draining guarantees each path is delivered exactly once regardless of ordering.
#[tauri::command]
fn take_opened_files(state: State<'_, OpenedFiles>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    std::mem::take(&mut *files)
}

/// Drain the file assigned to a spawned window (set by `open_document_window`).
/// Returns `None` once consumed, so a re-mount can't re-open a stale path.
#[tauri::command]
fn take_window_file(label: String, pending: State<'_, PendingWindowFile>) -> Option<String> {
    pending.0.lock().unwrap().remove(&label)
}

/// Spawn a second window of the SAME app to host `path` (MODE B). The path must
/// already be granted (it comes from a dialog pick, OS open, or an already-open
/// entry — all of which grant it), so this only re-`ensure`s and never widens the
/// allowlist on its own. The new window inherits titleBarStyle/size from
/// tauri.conf.json via `from_config`; its frontend drains `path` on mount.
#[tauri::command]
fn open_document_window(
    path: String,
    app: AppHandle,
    allowed: State<'_, allowlist::AllowedPaths>,
    pending: State<'_, PendingWindowFile>,
) -> Result<(), String> {
    allowed.ensure(&path)?;
    let label = format!("doc-{}", NEXT_WIN.fetch_add(1, Ordering::Relaxed));
    pending.0.lock().unwrap().insert(label.clone(), path);
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "no window config to clone".to_string())?;
    cfg.label = label.clone();
    let window = tauri::WebviewWindowBuilder::from_config(&app, &cfg)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    wire_window(&window, &app);
    Ok(())
}

/// Queue the given file URLs and ping the focused window to drain them.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn queue_opened_urls(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter_map(|path| path.to_str().map(str::to_string))
        .collect();
    if paths.is_empty() {
        return;
    }
    if let Some(allowed) = app.try_state::<allowlist::AllowedPaths>() {
        for p in &paths {
            allowed.allow(p);
        }
    }
    if let Some(state) = app.try_state::<OpenedFiles>() {
        state.0.lock().unwrap().extend(paths);
    }
    // Ping the focused window (which decides tab-vs-window per its own
    // openMode preference). Fall back to `main` when nothing is focused yet.
    let focused = app
        .try_state::<FocusedWindow>()
        .and_then(|f| f.0.lock().unwrap().clone());
    let target = menu_target(&focused);
    let _ = app.emit_to(
        EventTarget::webview_window(&target),
        "file:opened",
        serde_json::json!({ "target": target }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(OpenedFiles::default())
        .manage(FocusedWindow::default())
        .manage(PendingWindowFile::default())
        .manage(watcher::FileWatcher::default())
        .manage(allowlist::AllowedPaths::default())
        .manage(pdf::PendingPrintHtml::default())
        .manage(history::HistoryLocks::default())
        // Serves the pending PDF-export HTML to the ephemeral print window.
        // WebviewUrl has no raw-HTML variant and wry rejects data: URLs for
        // navigation, so the export HTML is delivered through this scheme.
        .register_uri_scheme_protocol("pdfprint", |ctx, _req| {
            let body =
                pdf::pending_print_body(ctx.app_handle().state::<pdf::PendingPrintHtml>().inner());
            tauri::http::Response::builder()
                .header(tauri::http::header::CONTENT_TYPE, "text/html")
                .body(body)
                .unwrap()
        });

    // Must be registered on the builder (before config windows are created):
    // the plugin restores state only in its window-created hook, and "main"
    // already exists by the time `setup` runs in this app.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let menu = menu::build(app)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app_handle, event| {
                // Menu item ids ARE the event names (e.g. "menu:open"). An app-
                // global macOS menu bar carries no window identity, so route the
                // command to the focused window rather than broadcasting it (in
                // MODE B a broadcast would fire in every window at once).
                let focused = app_handle
                    .state::<FocusedWindow>()
                    .0
                    .lock()
                    .unwrap()
                    .clone();
                let target = menu_target(&focused);
                let _ = app_handle.emit_to(
                    EventTarget::webview_window(&target),
                    event.id().0.as_str(),
                    serde_json::json!({ "target": target }),
                );
            });

            // Wire the config-defined `main` window the same way spawned
            // windows are wired: focus tracking + per-window close routing.
            let main = app.get_webview_window("main").unwrap();
            wire_window(&main, app.handle());

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            take_opened_files,
            take_window_file,
            open_document_window,
            watcher::watch_file,
            watcher::unwatch,
            dialogs::open_file_dialog,
            dialogs::save_file_dialog,
            dialogs::open_workspace_dialog,
            workspace::list_workspace,
            workspace::restore_workspace,
            fileops::create_file,
            fileops::create_folder,
            fileops::rename_entry,
            fileops::move_entry,
            fileops::copy_entry,
            fileops::duplicate_entry,
            fileops::delete_entries,
            history::record_history,
            history::list_history,
            history::read_history_version,
            pdf::export_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // On macOS/iOS, files opened from Finder arrive as an `Opened` run event
            // rather than as process arguments.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                queue_opened_urls(_app_handle, urls);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_target_prefers_focused_label() {
        assert_eq!(menu_target(&Some("doc-3".to_string())), "doc-3");
    }

    #[test]
    fn menu_target_defaults_to_main_when_unfocused() {
        assert_eq!(menu_target(&None), "main");
    }

    #[test]
    fn pending_window_file_drains_exactly_once() {
        // take_window_file's body is `pending.0.lock().remove(&label)`; assert
        // the drain-once semantics that stop a re-mount re-opening a stale path.
        let pending = PendingWindowFile::default();
        pending
            .0
            .lock()
            .unwrap()
            .insert("doc-1".into(), "/docs/a.md".into());
        assert_eq!(
            pending.0.lock().unwrap().remove("doc-1"),
            Some("/docs/a.md".to_string())
        );
        assert_eq!(pending.0.lock().unwrap().remove("doc-1"), None);
    }

    #[test]
    fn spawned_labels_are_unique_and_doc_prefixed() {
        // The counter must hand out distinct `doc-*` labels (capabilities glob
        // `doc-*` depends on the prefix; the map keys on the label).
        let a = NEXT_WIN.fetch_add(1, Ordering::Relaxed);
        let b = NEXT_WIN.fetch_add(1, Ordering::Relaxed);
        assert_ne!(a, b);
        assert!(format!("doc-{a}").starts_with("doc-"));
    }
}
