mod allowlist;
mod commands;
mod dialogs;
mod menu;
mod pdf;
mod watcher;
mod workspace;

use std::sync::Mutex;

use tauri::Emitter;
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Buffer of file paths macOS asked us to open (via Finder double-click / `open`).
/// Needed because on a cold launch the OS delivers the file before the webview's
/// JS listeners exist, so we stash paths here until the frontend drains them.
#[derive(Default)]
pub struct OpenedFiles(pub Mutex<Vec<String>>);

/// Drain and return any pending file-open paths. The frontend calls this on mount
/// (cold start) and whenever a `file:opened` event fires (already-running app).
/// Draining guarantees each path is delivered exactly once regardless of ordering.
#[tauri::command]
fn take_opened_files(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    std::mem::take(&mut *files)
}

/// Queue the given file URLs and ping the frontend to drain them.
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
    let _ = app.emit("file:opened", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(OpenedFiles::default())
        .manage(watcher::FileWatcher::default())
        .manage(allowlist::AllowedPaths::default())
        .manage(pdf::PendingPrintHtml::default())
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
                // Menu item ids ARE the event names (e.g. "menu:open").
                let _ = app_handle.emit(event.id().0.as_str(), ());
            });

            let window = app.get_webview_window("main").unwrap();
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Belt-and-braces: the plugin normally persists on RunEvent::Exit,
                    // which still fires after the frontend calls window.destroy(),
                    // but saving here makes persistence independent of exit handling.
                    #[cfg(desktop)]
                    let _ = handle.save_window_state(StateFlags::all());
                    let _ = handle.emit("window:close-requested", ());
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            take_opened_files,
            watcher::watch_file,
            watcher::unwatch,
            dialogs::open_file_dialog,
            dialogs::save_file_dialog,
            dialogs::open_workspace_dialog,
            workspace::list_workspace,
            workspace::restore_workspace,
            pdf::export_pdf,
            pdf::close_pdf_export
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
