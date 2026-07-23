mod allowlist;
mod commands;
mod dialogs;
mod fileops;
mod history;
mod launch;
mod menu;
mod pdf;
mod prefs;
mod watcher;
mod windows;
mod workspace;

use std::sync::Mutex;

use tauri::{Emitter, EventTarget, Manager, State};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use windows::{menu_target, wire_window, FocusedWindow, PendingWindowFile};

/// One queued open: the path plus whether it must open read-only. OS-association
/// opens (Finder double-click / `open`) queue `readonly: true` — the safety-net
/// banner + "Enable editing" — while argv files handed to a spawned instance
/// queue `readonly: false`: they are trusted local opens the user explicitly
/// routed here (open_file_new_instance / CLI), not surprise associations.
#[derive(Clone, serde::Serialize)]
pub struct OpenedEntry {
    pub path: String,
    pub readonly: bool,
}

/// Buffer of files the OS or a spawner asked us to open (Finder double-click /
/// `open` / argv). Needed because on a cold launch the OS delivers the file
/// before the webview's JS listeners exist, so we stash entries here until the
/// frontend drains them.
///
/// POISON POLICY (one statement covering every `Mutex` behind these state
/// newtypes — `OpenedFiles`, `FocusedWindow`, `PendingWindowFile`,
/// `watcher::FileWatcher`, `watcher::WorkspaceWatcher`,
/// `pdf::PendingPrintHtml`, `launch::StartupWorkspace`,
/// plus `allowlist::AllowedPaths` and `history::HistoryLocks`): each lock is
/// `unwrap()`'d on poison
/// deliberately. These are single-process, short-held locks guarding trivial
/// in-memory bookkeeping; a panic while one is held leaves the process in an
/// unknown state, so propagating the poison as a hard crash is the intended,
/// fail-fast behavior — never recovered from, never swallowed.
#[derive(Default)]
pub struct OpenedFiles(Mutex<Vec<OpenedEntry>>);

impl OpenedFiles {
    /// Drain and return every buffered entry, leaving the buffer empty
    /// (`mem::take`). Draining is what guarantees each queued entry is delivered
    /// exactly once regardless of ordering.
    pub fn take_all(&self) -> Vec<OpenedEntry> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }

    /// Append freshly granted open entries to the buffer.
    pub fn extend(&self, entries: impl IntoIterator<Item = OpenedEntry>) {
        self.0.lock().unwrap().extend(entries);
    }
}

/// Best-effort asset-protocol grant for `dir`, so convertFileSrc URLs in it
/// render in the webview. `recursive: true` is reserved for explicitly picked
/// workspace roots; a single-file open/save grants its parent NON-recursively
/// (same-directory image refs only) — a recursive grant on e.g. `~` would give
/// the display channel the whole home tree for the process lifetime, since
/// FsScope grants are irrevocable. Subdirectory/updir image refs are instead
/// resolved per-file via `commands::resolve_image_asset`. Display-channel
/// only: `asset:` appears solely in the CSP's img-src, while read/write IPC
/// still enforces exact grants via `AllowedPaths::ensure` — the allowlist
/// trust boundary is unchanged. Mirrors save_pasted_image's posture: a failed
/// grant merely degrades image display, so it must never fail the operation
/// that granted.
pub(crate) fn allow_asset_dir(app: &tauri::AppHandle, dir: &std::path::Path, recursive: bool) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, recursive) {
        log::warn!("could not add {dir:?} to asset scope: {e}");
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

/// Drain and return any pending file-open entries (path + per-entry readonly).
/// The frontend calls this on mount (cold start) and whenever a `file:opened`
/// event fires (already-running app). Draining guarantees each entry is
/// delivered exactly once regardless of ordering.
///
/// Each drained entry's parent directory also gets a NON-recursive asset-scope
/// grant so the doc's same-directory image references render (deeper relative
/// refs go through resolve_image_asset). Drain time is the earliest uniform
/// point with an AppHandle for BOTH delivery routes (macOS `Opened` events and
/// argv files granted in `run()` pre-Builder), and rendering always happens
/// after the drain.
#[tauri::command]
fn take_opened_files(app: tauri::AppHandle, state: State<'_, OpenedFiles>) -> Vec<OpenedEntry> {
    let entries = state.take_all();
    for e in &entries {
        if let Some(dir) = std::path::Path::new(&e.path).parent() {
            allow_asset_dir(&app, dir, false);
        }
    }
    entries
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
        // OS-association opens keep the read-only safety net: the user asked
        // the OS to "open with", not to edit — see OpenedEntry's doc comment.
        state.extend(paths.into_iter().map(|path| OpenedEntry {
            path,
            readonly: true,
        }));
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
    // launch.rs): positional files are granted + queued like Finder opens
    // (queue_opened_urls), except each entry is queued `readonly: false` —
    // argv files are trusted local opens the user explicitly routed here
    // (open_file_new_instance / CLI), so the frontend's take_opened_files
    // drain opens them pinned and editable on mount, while Finder opens keep
    // their per-entry read-only safety net. The --workspace dir is stashed for
    // the frontend to claim via take_startup_workspace. Seeding happens on the
    // freshly built state objects BEFORE .manage(), so no window can race a
    // half-seeded queue.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch_args = launch::parse_launch_args(&args);
    // Computed BEFORE launch_args.workspace is moved into StartupWorkspace: a
    // handed-off child (spawned with --workspace and/or argv files) must
    // neither restore the spawner's persisted folder (suppress_restore, see
    // StartupWorkspace) nor touch the spawner's window geometry — all
    // instances share one window-state file, so a child restoring would
    // pixel-stack exactly on top of its parent, and a child SAVING would
    // clobber the parent's geometry (see the window-state plugin block below).
    let handed_off = launch_args.is_handoff();
    let opened = OpenedFiles::default();
    let allowed = allowlist::AllowedPaths::default();
    let startup_files = launch_args
        .files
        .iter()
        .filter_map(|p| p.to_str().map(str::to_string));
    for p in startup_files {
        allowed.allow(&p);
        opened.extend([OpenedEntry {
            path: p,
            readonly: false,
        }]);
    }

    let builder = tauri::Builder::default()
        .manage(opened)
        .manage(FocusedWindow::default())
        .manage(PendingWindowFile::default())
        .manage(watcher::FileWatcher::default())
        .manage(watcher::WorkspaceWatcher::default())
        .manage(allowed)
        .manage(launch::StartupWorkspace::new(
            launch_args.workspace,
            handed_off,
        ))
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
    // already exists by the time `setup` runs in this app. A handed-off child
    // gets NO plugin at all — neither restore nor save: all instances share
    // one state file, so restoring would stack the child pixel-exactly on the
    // parent that just spawned it (OS-default placement is the honest "new
    // window" behavior), and saving — the plugin's RunEvent::Exit auto-save or
    // the explicit save in wire_window — would clobber the parent's geometry
    // with the child's (worse still, `doc-N` labels collide across
    // instances). wire_window gates its explicit save on the same handoff
    // signal, which is mandatory: save_window_state panics when the plugin is
    // unregistered.
    #[cfg(desktop)]
    let builder = if handed_off {
        builder
    } else {
        builder.plugin(tauri_plugin_window_state::Builder::default().build())
    };

    builder
        .setup(move |app| {
            // Release error sink: everything log:: (Rust) and the webview's
            // forwarded console/errors (src/lib/logging.ts) land in
            // <app-log-dir>/markdon.log, capped at ~1 MB with one rotation.
            // Deliberately NO TargetKind::Webview (and no attachConsole in
            // JS): the frontend forwards console.warn/error INTO this plugin,
            // so echoing plugin output back to the webview console would loop.
            // Handed-off instances write markdon-<pid>.log instead: the
            // plugin's size-cap rotation unlinks the live file, so two
            // processes sharing one file silently lose whichever side kept
            // the stale descriptor — exactly the crash lines this sink
            // exists to preserve. The primary sweeps stale per-pid files.
            let log_file = if handed_off {
                Some(format!("markdon-{}", std::process::id()))
            } else {
                if let Ok(dir) = app.path().app_log_dir() {
                    if let Ok(entries) = std::fs::read_dir(&dir) {
                        for entry in entries.flatten() {
                            let name = entry.file_name();
                            let name = name.to_string_lossy();
                            if name.starts_with("markdon-") && name.ends_with(".log") {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
                None
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .targets([
                        Target::new(TargetKind::Stdout),
                        Target::new(TargetKind::LogDir {
                            file_name: log_file,
                        }),
                    ])
                    .max_file_size(1_000_000)
                    .rotation_strategy(RotationStrategy::KeepOne)
                    .build(),
            )?;

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
            commands::resolve_image_asset,
            take_opened_files,
            windows::take_window_file,
            set_readonly_menu_state,
            windows::open_document_window,
            windows::open_file_new_instance,
            watcher::watch_file,
            watcher::unwatch,
            watcher::watch_workspace,
            watcher::unwatch_workspace,
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
            fileops::save_pasted_image,
            history::record_history,
            history::list_history,
            history::read_history_version,
            prefs::load_prefs,
            prefs::save_prefs,
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

    fn entry(path: &str, readonly: bool) -> OpenedEntry {
        OpenedEntry {
            path: path.into(),
            readonly,
        }
    }

    #[test]
    fn opened_files_take_all_drains_and_extend_appends() {
        // Pins the accessor surface: extend appends, take_all drains (mem::take)
        // so a second drain yields nothing — the exactly-once delivery guarantee.
        let of = OpenedFiles::default();
        of.extend(vec![entry("/a.md", true), entry("/b.md", true)]);
        of.extend(vec![entry("/c.md", false)]);
        let paths: Vec<String> = of.take_all().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["/a.md", "/b.md", "/c.md"]);
        assert!(of.take_all().is_empty());
    }

    #[test]
    fn opened_files_entries_carry_per_entry_readonly() {
        // Finder opens queue readonly, argv files editable — the flag must
        // survive the queue verbatim so the drain can honor each entry's own.
        let of = OpenedFiles::default();
        of.extend(vec![entry("/finder.md", true), entry("/argv.md", false)]);
        let drained = of.take_all();
        assert_eq!(
            drained
                .iter()
                .map(|e| (e.path.as_str(), e.readonly))
                .collect::<Vec<_>>(),
            vec![("/finder.md", true), ("/argv.md", false)]
        );
    }

    #[test]
    fn opened_entry_serializes_path_and_readonly() {
        // The wire shape the frontend drain relies on: verbatim field names,
        // no serde renames — matching AssignedFile in windows.rs.
        let json = serde_json::to_string(&entry("/a.md", true)).unwrap();
        assert_eq!(json, r#"{"path":"/a.md","readonly":true}"#);
    }
}
