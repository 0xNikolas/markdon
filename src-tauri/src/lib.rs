mod allowlist;
mod commands;
mod dialogs;
mod fileops;
mod history;
mod launch;
mod menu;
mod pdf;
mod watcher;
mod windows;
mod workspace;

use std::sync::Mutex;

use tauri::{Emitter, EventTarget, Manager, State};

use windows::{menu_target, wire_window, FocusedWindow, PendingWindowFile};

/// Buffer of file paths macOS asked us to open (via Finder double-click / `open`).
/// Needed because on a cold launch the OS delivers the file before the webview's
/// JS listeners exist, so we stash paths here until the frontend drains them.
///
/// POISON POLICY (one statement covering every `Mutex` behind these state
/// newtypes — `OpenedFiles`, `FocusedWindow`, `PendingWindowFile`,
/// `watcher::FileWatcher`, `pdf::PendingPrintHtml`, `launch::StartupWorkspace`,
/// plus `allowlist::AllowedPaths` and `history::HistoryLocks`): each lock is
/// `unwrap()`'d on poison
/// deliberately. These are single-process, short-held locks guarding trivial
/// in-memory bookkeeping; a panic while one is held leaves the process in an
/// unknown state, so propagating the poison as a hard crash is the intended,
/// fail-fast behavior — never recovered from, never swallowed.
#[derive(Default)]
pub struct OpenedFiles(Mutex<Vec<String>>);

impl OpenedFiles {
    /// Drain and return every buffered path, leaving the buffer empty
    /// (`mem::take`). Draining is what guarantees each queued path is delivered
    /// exactly once regardless of ordering.
    pub fn take_all(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }

    /// Append freshly granted open paths to the buffer.
    pub fn extend(&self, paths: impl IntoIterator<Item = String>) {
        self.0.lock().unwrap().extend(paths);
    }
}

/// Handle to the File-menu "Read Only" CheckMenuItem. The app menu is
/// app-global (one menu bar for all windows), and `Menu::get` doesn't reach
/// nested items, so the item is stashed here at menu-build time. The frontend
/// pushes the checked state from the doc store — the single source of truth —
/// via `set_readonly_menu_state`. The inner `CheckMenuItem` is Arc-backed and
/// tauri marks it Send+Sync; `set_checked` dispatches to the main thread itself,
/// so no extra lock is needed.
pub struct ReadonlyMenuItem(pub tauri::menu::CheckMenuItem<tauri::Wry>);

/// Drain and return any pending file-open paths. The frontend calls this on mount
/// (cold start) and whenever a `file:opened` event fires (already-running app).
/// Draining guarantees each path is delivered exactly once regardless of ordering.
#[tauri::command]
fn take_opened_files(state: State<'_, OpenedFiles>) -> Vec<String> {
    state.take_all()
}

/// Sync the File-menu "Read Only" check mark to the doc store. The
/// frontend calls this on mount and whenever `$doc.readonly` changes, so the
/// store stays the single source of truth: Finder read-only opens, the banner's
/// "Enable editing", and the manual toggle all flow through the same store
/// subscription. Also corrects muda's optimistic on-click toggle when a dirty
/// manual toggle is cancelled (the store never changed, so pushing its actual
/// value un-checks the item).
#[tauri::command]
fn set_readonly_menu_state(checked: bool, item: State<'_, ReadonlyMenuItem>) -> Result<(), String> {
    item.0.set_checked(checked).map_err(|e| e.to_string())
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
        state.extend(paths);
    }
    // Ping the focused window (which decides tab-vs-window per its own
    // openMode preference). Fall back to `main` when nothing is focused yet.
    let focused = app.try_state::<FocusedWindow>().and_then(|f| f.get());
    let target = menu_target(&focused);
    let _ = app.emit_to(
        EventTarget::webview_window(&target),
        "file:opened",
        serde_json::json!({ "target": target }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Argv is how a spawned "new instance" receives its work order (see
    // launch.rs): positional files are granted + queued exactly like Finder
    // opens (queue_opened_urls), so the frontend's normal take_opened_files
    // drain opens them pinned and editable on mount — argv files are trusted
    // local opens, and OpenedFiles carries no readonly flag, so nothing here
    // can accidentally mark them read-only. The --workspace dir is stashed for
    // the frontend to claim via take_startup_workspace. Seeding happens on the
    // freshly built state objects BEFORE .manage(), so no window can race a
    // half-seeded queue.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch_args = launch::parse_launch_args(&args);
    let opened = OpenedFiles::default();
    let allowed = allowlist::AllowedPaths::default();
    let startup_files = launch_args
        .files
        .iter()
        .filter_map(|p| p.to_str().map(str::to_string));
    for p in startup_files {
        allowed.allow(&p);
        opened.extend([p]);
    }

    let builder = tauri::Builder::default()
        .manage(opened)
        .manage(FocusedWindow::default())
        .manage(PendingWindowFile::default())
        .manage(watcher::FileWatcher::default())
        .manage(allowed)
        .manage(launch::StartupWorkspace::new(launch_args.workspace))
        .manage(pdf::PendingPrintHtml::default())
        .manage(history::HistoryLocks::default())
        // Serves the pending PDF-export HTML to the ephemeral print window.
        // WebviewUrl has no raw-HTML variant and wry rejects data: URLs for
        // navigation, so the export HTML is delivered through this scheme.
        .register_uri_scheme_protocol("pdfprint", |ctx, _req| {
            let body = ctx.app_handle().state::<pdf::PendingPrintHtml>().body();
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

            let (menu, readonly_item) = menu::build(app)?;
            app.set_menu(menu)?;
            // Stash the "Read Only" CheckMenuItem so set_readonly_menu_state can
            // drive its checked state from the doc store.
            app.manage(ReadonlyMenuItem(readonly_item));
            app.on_menu_event(|app_handle, event| {
                // Menu item ids ARE the event names (e.g. "menu:open"). An app-
                // global macOS menu bar carries no window identity, so route the
                // command to the focused window rather than broadcasting it (in
                // MODE B a broadcast would fire in every window at once).
                let focused = app_handle.state::<FocusedWindow>().get();
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
            windows::take_window_file,
            set_readonly_menu_state,
            windows::open_document_window,
            windows::open_file_new_instance,
            watcher::watch_file,
            watcher::unwatch,
            dialogs::open_file_dialog,
            dialogs::save_file_dialog,
            dialogs::open_workspace_dialog,
            dialogs::pick_folder_new_instance,
            workspace::list_workspace,
            workspace::restore_workspace,
            workspace::close_workspace,
            workspace::take_startup_workspace,
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
    fn opened_files_take_all_drains_and_extend_appends() {
        // Pins the accessor surface: extend appends, take_all drains (mem::take)
        // so a second drain yields nothing — the exactly-once delivery guarantee.
        let of = OpenedFiles::default();
        of.extend(vec!["/a.md".to_string(), "/b.md".to_string()]);
        of.extend(vec!["/c.md".to_string()]);
        assert_eq!(of.take_all(), vec!["/a.md", "/b.md", "/c.md"]);
        assert!(of.take_all().is_empty());
    }
}
