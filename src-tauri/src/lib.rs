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

/// A file assigned to a spawned document window, including whether it must open
/// read-only. Carrying the flag through the hand-off preserves the Finder-open
/// safety net in MODE B: an OS-association open is read-only (banner + "Enable
/// editing") regardless of which window ends up hosting it.
#[derive(Clone, serde::Serialize)]
pub struct AssignedFile {
    pub path: String,
    pub readonly: bool,
}

/// Files assigned to a spawned document window but not yet consumed by it. The
/// spawner stashes `label -> assignment` here; the new window's frontend drains
/// its own entry on mount via `take_window_file`.
#[derive(Default)]
pub struct PendingWindowFile(pub Mutex<HashMap<String, AssignedFile>>);

/// Handle to the File-menu "Read Only" CheckMenuItem (task 25). The app menu is
/// app-global (one menu bar for all windows), and `Menu::get` doesn't reach
/// nested items, so the item is stashed here at menu-build time. The frontend
/// pushes the checked state from the doc store — the single source of truth —
/// via `set_readonly_menu_state`. The inner `CheckMenuItem` is Arc-backed and
/// tauri marks it Send+Sync; `set_checked` dispatches to the main thread itself,
/// so no extra lock is needed.
pub struct ReadonlyMenuItem(pub tauri::menu::CheckMenuItem<tauri::Wry>);

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

/// Release a closing window's per-label bookkeeping outside of `FileWatcher`
/// (handled inline in `wire_window`, since it needs the notify-backed state
/// object): drops any still-pending file hand-off for `label`, and clears
/// `FocusedWindow` if -- and only if -- it currently names this same window,
/// so a closed doc-N window never leaves menu routing pointed at a label that
/// no longer exists (it would otherwise silently no-op via `emit_to` until
/// some other window is refocused). Pure aside from the two mutex locks, so
/// it is unit-testable without a live window.
fn release_window_state(label: &str, pending: &PendingWindowFile, focused: &FocusedWindow) {
    pending.0.lock().unwrap().remove(label);
    let mut f = focused.0.lock().unwrap();
    if f.as_deref() == Some(label) {
        *f = None;
    }
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
        tauri::WindowEvent::Destroyed => {
            // A destroyed window can never receive events again. Drop its
            // watcher entry here (the frontend's own unwatch never runs — the
            // close path tears the webview down via window.destroy(), killing
            // the JS realm abruptly), which stops the notify thread; then clear
            // the remaining per-label bookkeeping. Without this, every open-
            // then-close of a doc-N window leaks a live FS-watcher thread.
            app_close
                .state::<watcher::FileWatcher>()
                .0
                .lock()
                .unwrap()
                .remove(&lbl_close);
            release_window_state(
                &lbl_close,
                app_close.state::<PendingWindowFile>().inner(),
                app_close.state::<FocusedWindow>().inner(),
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
///
/// `window` is injected by Tauri from the calling webview (like
/// `watch_file`/`unwatch` in watcher.rs) rather than taken as a caller-supplied
/// string. `doc-*` labels are a predictable sequential counter, so accepting a
/// caller-supplied label would let any window's frontend drain (steal) the
/// file hand-off intended for a different, possibly not-yet-mounted window.
#[tauri::command]
fn take_window_file(
    window: WebviewWindow,
    pending: State<'_, PendingWindowFile>,
) -> Option<AssignedFile> {
    pending.0.lock().unwrap().remove(window.label())
}

/// Sync the File-menu "Read Only" check mark to the doc store (task 25). The
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

/// Spawn a second window of the SAME app to host `path` (MODE B). The path must
/// already be granted (it comes from a dialog pick, OS open, or an already-open
/// entry — all of which grant it), so this only re-`ensure`s and never widens the
/// allowlist on its own. The new window inherits titleBarStyle/size from
/// tauri.conf.json via `from_config`; its frontend drains `path` on mount.
#[tauri::command]
fn open_document_window(
    path: String,
    readonly: bool,
    app: AppHandle,
    allowed: State<'_, allowlist::AllowedPaths>,
    pending: State<'_, PendingWindowFile>,
) -> Result<(), String> {
    allowed.ensure(&path)?;
    let label = format!("doc-{}", NEXT_WIN.fetch_add(1, Ordering::Relaxed));
    // The entry must exist BEFORE the window is built (its frontend may mount
    // and drain immediately), so failure below has to roll it back — otherwise
    // a failed spawn leaks an entry no window will ever drain.
    pending
        .0
        .lock()
        .unwrap()
        .insert(label.clone(), AssignedFile { path, readonly });
    let built = (|| {
        let mut cfg = app
            .config()
            .app
            .windows
            .first()
            .cloned()
            .ok_or_else(|| "no window config to clone".to_string())?;
        cfg.label = label.clone();
        tauri::WebviewWindowBuilder::from_config(&app, &cfg)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())
    })();
    match built {
        Ok(window) => {
            wire_window(&window, &app);
            Ok(())
        }
        Err(e) => {
            pending.0.lock().unwrap().remove(&label);
            Err(e)
        }
    }
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

            let (menu, readonly_item) = menu::build(app)?;
            app.set_menu(menu)?;
            // Stash the "Read Only" CheckMenuItem so set_readonly_menu_state can
            // drive its checked state from the doc store (task 25).
            app.manage(ReadonlyMenuItem(readonly_item));
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
            set_readonly_menu_state,
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

    fn assigned(path: &str, readonly: bool) -> AssignedFile {
        AssignedFile {
            path: path.into(),
            readonly,
        }
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
            .insert("doc-1".into(), assigned("/docs/a.md", false));
        let taken = pending.0.lock().unwrap().remove("doc-1");
        assert_eq!(taken.map(|a| a.path), Some("/docs/a.md".to_string()));
        assert!(pending.0.lock().unwrap().remove("doc-1").is_none());
    }

    #[test]
    fn pending_window_file_carries_the_readonly_flag() {
        // MODE B Finder opens must stay read-only in the spawned window; the
        // flag rides the hand-off so the drain can pass it to openPath.
        let pending = PendingWindowFile::default();
        pending
            .0
            .lock()
            .unwrap()
            .insert("doc-1".into(), assigned("/docs/a.md", true));
        let taken = pending.0.lock().unwrap().remove("doc-1").unwrap();
        assert!(taken.readonly);
    }

    #[test]
    fn release_window_state_drops_pending_and_matching_focus() {
        let pending = PendingWindowFile::default();
        let focused = FocusedWindow::default();
        pending
            .0
            .lock()
            .unwrap()
            .insert("doc-2".into(), assigned("/docs/b.md", false));
        *focused.0.lock().unwrap() = Some("doc-2".into());

        release_window_state("doc-2", &pending, &focused);

        assert!(pending.0.lock().unwrap().is_empty());
        assert_eq!(*focused.0.lock().unwrap(), None);
    }

    #[test]
    fn release_window_state_leaves_other_windows_focus_alone() {
        // Closing doc-2 while doc-1 is focused must not clear doc-1's focus —
        // menu routing would silently fall back to `main` otherwise.
        let pending = PendingWindowFile::default();
        let focused = FocusedWindow::default();
        *focused.0.lock().unwrap() = Some("doc-1".into());

        release_window_state("doc-2", &pending, &focused);

        assert_eq!(*focused.0.lock().unwrap(), Some("doc-1".to_string()));
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
