use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::allowlist;
use crate::watcher;

/// The label of the window that currently has focus, self-tracked from
/// `WindowEvent::Focused(true)` (the stable API — `get_focused_window()` is gated
/// behind Tauri's `unstable` feature, deliberately avoided). MODE B routes app-
/// global macOS menu commands to this window, since an app menu bar carries no
/// window identity of its own.
#[derive(Default)]
pub struct FocusedWindow(Mutex<Option<String>>);

impl FocusedWindow {
    /// Record which window label now holds focus (`None` clears it).
    pub fn set(&self, label: Option<String>) {
        *self.0.lock().unwrap() = label;
    }

    /// The currently focused window label, if any.
    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    /// Clear focus iff it currently names `label`, so a closing window never
    /// leaves menu routing pointed at a label that no longer exists. Clearing
    /// some other window's focus would silently drop menu routing to `main`.
    pub fn clear_if(&self, label: &str) {
        let mut f = self.0.lock().unwrap();
        if f.as_deref() == Some(label) {
            *f = None;
        }
    }
}

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
pub struct PendingWindowFile(Mutex<HashMap<String, AssignedFile>>);

impl PendingWindowFile {
    /// Stash the file hand-off for a spawned window, keyed by its label.
    pub fn insert(&self, label: String, file: AssignedFile) {
        self.0.lock().unwrap().insert(label, file);
    }

    /// Drain and return the hand-off for `label`. Returning `None` once consumed
    /// is what stops a re-mount re-opening a stale path.
    pub fn take(&self, label: &str) -> Option<AssignedFile> {
        self.0.lock().unwrap().remove(label)
    }

    /// Drop any still-pending hand-off for `label` (a closed window, or a failed
    /// spawn rolling back its own entry). No-op when nothing is pending.
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

/// Monotonic counter for spawned-window labels (`doc-1`, `doc-2`, …). The
/// `doc-*` prefix is load-bearing: capabilities/default.json grants the default
/// permission set to `doc-*`, so any future spawned window MUST keep this prefix
/// or it will silently lack IPC/event permissions.
static NEXT_WIN: AtomicU64 = AtomicU64::new(1);

/// Which window label should receive an app-global menu command: the focused
/// one, falling back to `main` when nothing is tracked as focused (e.g. a menu
/// clicked while a native dialog owns focus). Pure so it is unit-testable
/// without a GUI.
pub fn menu_target(focused: &Option<String>) -> String {
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
    pending.remove(label);
    focused.clear_if(label);
}

/// Per-window setup applied to BOTH the config `main` window and every spawned
/// `doc-*` window: self-tracks focus into `FocusedWindow`, and handles close
/// requests per-window (routing `window:close-requested` to the closing window
/// only, so one window's close prompt never fires in another).
pub fn wire_window(window: &WebviewWindow, app: &AppHandle) {
    let label = window.label().to_string();

    // Seed focus on creation so a menu command issued before the first
    // Focused(true) event still has a best-effort target.
    if window.is_focused().unwrap_or(false) {
        app.state::<FocusedWindow>().set(Some(label.clone()));
    }

    let app_focus = app.clone();
    let lbl_focus = label.clone();
    let app_close = app.clone();
    let lbl_close = label;
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(true) => {
            app_focus
                .state::<FocusedWindow>()
                .set(Some(lbl_focus.clone()));
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
            app_close.state::<watcher::FileWatcher>().remove(&lbl_close);
            release_window_state(
                &lbl_close,
                app_close.state::<PendingWindowFile>().inner(),
                app_close.state::<FocusedWindow>().inner(),
            );
        }
        _ => {}
    });
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
pub fn take_window_file(
    window: WebviewWindow,
    pending: State<'_, PendingWindowFile>,
) -> Option<AssignedFile> {
    pending.take(window.label())
}

/// Spawn a second window of the SAME app to host `path` (MODE B). The path must
/// already be granted (it comes from a dialog pick, OS open, or an already-open
/// entry — all of which grant it), so this only re-`ensure`s and never widens the
/// allowlist on its own. The new window inherits titleBarStyle/size from
/// tauri.conf.json via `from_config`; its frontend drains `path` on mount.
#[tauri::command]
pub fn open_document_window(
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
    pending.insert(label.clone(), AssignedFile { path, readonly });
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
            pending.remove(&label);
            Err(e)
        }
    }
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
        // take_window_file's body is `pending.take(label)`; assert the drain-once
        // semantics that stop a re-mount re-opening a stale path.
        let pending = PendingWindowFile::default();
        pending.insert("doc-1".into(), assigned("/docs/a.md", false));
        let taken = pending.take("doc-1");
        assert_eq!(taken.map(|a| a.path), Some("/docs/a.md".to_string()));
        assert!(pending.take("doc-1").is_none());
    }

    #[test]
    fn pending_window_file_carries_the_readonly_flag() {
        // MODE B Finder opens must stay read-only in the spawned window; the
        // flag rides the hand-off so the drain can pass it to openPath.
        let pending = PendingWindowFile::default();
        pending.insert("doc-1".into(), assigned("/docs/a.md", true));
        let taken = pending.take("doc-1").unwrap();
        assert!(taken.readonly);
    }

    #[test]
    fn release_window_state_drops_pending_and_matching_focus() {
        let pending = PendingWindowFile::default();
        let focused = FocusedWindow::default();
        pending.insert("doc-2".into(), assigned("/docs/b.md", false));
        focused.set(Some("doc-2".into()));

        release_window_state("doc-2", &pending, &focused);

        assert!(pending.take("doc-2").is_none());
        assert_eq!(focused.get(), None);
    }

    #[test]
    fn release_window_state_leaves_other_windows_focus_alone() {
        // Closing doc-2 while doc-1 is focused must not clear doc-1's focus —
        // menu routing would silently fall back to `main` otherwise.
        let pending = PendingWindowFile::default();
        let focused = FocusedWindow::default();
        focused.set(Some("doc-1".into()));

        release_window_state("doc-2", &pending, &focused);

        assert_eq!(focused.get(), Some("doc-1".to_string()));
    }

    #[test]
    fn focused_window_set_get_and_clear_if() {
        let fw = FocusedWindow::default();
        assert_eq!(fw.get(), None);
        fw.set(Some("doc-1".into()));
        assert_eq!(fw.get(), Some("doc-1".to_string()));
        // clear_if only clears when the label matches.
        fw.clear_if("doc-2");
        assert_eq!(fw.get(), Some("doc-1".to_string()));
        fw.clear_if("doc-1");
        assert_eq!(fw.get(), None);
    }

    #[test]
    fn pending_window_file_insert_take_remove() {
        let pending = PendingWindowFile::default();
        pending.insert("doc-1".into(), assigned("/docs/a.md", false));
        // take drains and returns the value.
        assert_eq!(
            pending.take("doc-1").map(|a| a.path),
            Some("/docs/a.md".to_string())
        );
        assert!(pending.take("doc-1").is_none());
        // remove is a drain that discards; no-op when absent.
        pending.insert("doc-2".into(), assigned("/docs/b.md", false));
        pending.remove("doc-2");
        assert!(pending.take("doc-2").is_none());
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
