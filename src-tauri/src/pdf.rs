//! PDF export via the native macOS print panel.
//!
//! There is no honest silent direct-to-file PDF API available to us: wry 0.55
//! surfaces only the native print panel (NSPrintOperation) and WKWebView's
//! `createPDFWithConfiguration:` is not exposed through tauri. So "export to
//! PDF" routes through the OS print panel, whose built-in "Save as PDF"
//! affordance writes the file -- the app never shows its own save dialog.
//!
//! Mechanism: the frontend builds the SAME clean, light-token standalone HTML
//! the HTML export produces (buildExportHtml) and hands it here. We stash it,
//! open a short-lived helper window, and load it via the `pdfprint://` custom
//! scheme (WebviewUrl has no raw-HTML variant, and wry rejects `data:` URLs for
//! navigation). Printing the helper -- not the main window -- keeps app chrome
//! (header, sidebar, split panes, dark theme) out of the PDF, so the artifact
//! matches the HTML export exactly.
//!
//! How the panel is actually presented (the previous approach did NOT work):
//! injecting a `window.print()` user script into the helper does nothing on
//! macOS -- WKWebView does not implement JS `window.print()`, and wry 0.55 has
//! no interception that forwards it to a print operation (the only print path
//! in wry is the Rust-side `WryWebView::print`, which builds an
//! `NSPrintOperation` -- see `wry-0.55.1/src/wkwebview/mod.rs`). So the helper
//! just sat there with no panel. Instead, once the helper's webview finishes
//! loading (`on_page_load` -> `PageLoadEvent::Finished`) we reach the WKWebView
//! via tauri's `with_webview` escape hatch and run
//! `printOperationWithPrintInfo:` + `runOperation` ourselves (objc2). That is
//! the real, documented AppKit print panel -- the one with the "PDF" popup ->
//! "Save as PDF" -> save sheet the user asked for. `runOperation` runs it
//! application-modally and blocks until the panel is dismissed (printed, saved,
//! or cancelled), after which we deterministically close the helper and drop
//! the stashed HTML -- no orphaned window on any path.
//!
//! Default save-as filename: the print operation's job title is set from the
//! document title (and the helper's own window title matches it), so the "Save
//! as PDF" sheet defaults to `<docTitle>.pdf`. The HTML `<title>` carries the
//! same value as a further backstop.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::SeExt;

/// HTML awaiting pickup by the `pdfprint://` scheme handler. Stashed here
/// because `WebviewUrl` has no raw-HTML variant; the handler drains it when the
/// helper window loads. Cleared on teardown so document content does not linger.
///
/// Poison policy: the inner `Mutex` is `unwrap()`'d on poison deliberately —
/// see the central note on `crate::OpenedFiles`.
#[derive(Default)]
pub struct PendingPrintHtml(Mutex<Option<String>>);

impl PendingPrintHtml {
    /// Stash the export HTML (`Some`) or clear it (`None`, on teardown).
    pub fn set(&self, html: Option<String>) {
        *self.0.lock().unwrap() = html;
    }

    /// The stashed HTML as bytes, or an empty document when nothing is pending —
    /// the body served by the `pdfprint://` scheme handler. This CLONES (it does
    /// not drain): teardown owns the clear, and `on_page_load` can fire more than
    /// once, so the body must survive re-reads until the helper tears down. Pure
    /// enough to unit-test without a running webview.
    pub fn body(&self) -> Vec<u8> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default()
            .into_bytes()
    }
}

/// Label of the ephemeral print window; also the URI-scheme authority host.
pub const PRINT_WINDOW_LABEL: &str = "pdf-print";

/// Resolves the helper print window's title (and the print job title) from the
/// exported document's title, falling back to a generic label when blank. This
/// is what seeds the "Save as PDF" default filename. Pure and unit-tested; the
/// non-pure `export_pdf` command below just calls it.
pub fn resolve_window_title(doc_title: &str) -> String {
    let trimmed = doc_title.trim();
    if trimmed.is_empty() {
        "Exporting to PDF…".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Stash the export HTML and open the helper print window. Returns immediately;
/// the native print panel is presented from `on_page_load` once the helper's
/// webview has rendered the document, and the helper tears itself down after
/// the panel is dismissed (see `present_print_panel` / `teardown`).
#[tauri::command]
pub async fn export_pdf(app: AppHandle, html: String, title: String) -> Result<(), String> {
    app.state::<PendingPrintHtml>().set(Some(html));

    // A prior export whose panel was never dismissed could still have a helper.
    if let Some(existing) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let url = "pdfprint://localhost/"
        .parse()
        .map_err(|_| "invalid pdfprint url".to_string())?;

    let window_title = resolve_window_title(&title);

    #[cfg(target_os = "macos")]
    let job_title = window_title.clone();
    // `on_page_load` can fire `Finished` more than once; only the first
    // presents the panel so we never stack two print operations.
    #[cfg(target_os = "macos")]
    let presented = Arc::new(AtomicBool::new(false));

    let builder =
        WebviewWindowBuilder::new(&app, PRINT_WINDOW_LABEL, WebviewUrl::CustomProtocol(url))
            .title(window_title)
            .inner_size(480.0, 600.0)
            .resizable(false)
            .center()
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished) {
                    return;
                }
                #[cfg(target_os = "macos")]
                if !presented.swap(true, Ordering::SeqCst) {
                    present_print_panel(window, job_title.clone());
                }
                // Non-macOS has no native print panel wired up; nothing to do.
                #[cfg(not(target_os = "macos"))]
                let _ = window;
            });

    builder.build().se()?;
    Ok(())
}

/// Present the native macOS print panel for the helper window's rendered
/// document, then tear the helper down. Runs the objc2 print path on the main
/// thread via `with_webview`; if that handle cannot be reached we still tear
/// down so no window is orphaned.
fn present_print_panel(window: WebviewWindow, job_title: String) {
    let app = window.app_handle().clone();
    let dispatched = window.with_webview(move |webview| {
        #[cfg(target_os = "macos")]
        run_native_print(webview.inner(), &job_title);
        #[cfg(not(target_os = "macos"))]
        let _ = (&webview, &job_title);
        teardown(&app);
    });
    if dispatched.is_err() {
        teardown(window.app_handle());
    }
}

/// Close the helper print window and drop the stashed HTML. Idempotent: a no-op
/// if the window is already gone.
fn teardown(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = window.close();
    }
    app.state::<PendingPrintHtml>().set(None);
}

/// Run the real AppKit print panel for a WKWebView and block until it is
/// dismissed. Mirrors wry's own `WryWebView::print`
/// (`wry-0.55.1/src/wkwebview/mod.rs`) but uses the blocking, application-modal
/// `runOperation` (not `runOperationModalForWindow:...`) so the caller knows
/// exactly when the user is done and can close the helper without racing the
/// PDF write.
#[cfg(target_os = "macos")]
fn run_native_print(webview_ptr: *mut std::ffi::c_void, job_title: &str) {
    use objc2::runtime::NSObjectProtocol;
    use objc2_app_kit::NSPrintInfo;
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;

    // SAFETY: `webview_ptr` is the WKWebView backing this Tauri window, handed
    // to us by tauri's `with_webview` on the main thread. The objc2 calls below
    // are the standard AppKit print path and mirror wry's own implementation.
    unsafe {
        let view: &WKWebView = &*webview_ptr.cast::<WKWebView>();
        // `printOperationWithPrintInfo:` is macOS 11+. Bail on older systems
        // rather than crash on an unrecognized selector.
        if !view.respondsToSelector(objc2::sel!(printOperationWithPrintInfo:)) {
            return;
        }
        let print_info = NSPrintInfo::sharedPrintInfo();
        let operation = view.printOperationWithPrintInfo(&print_info);
        if !job_title.is_empty() {
            // Seeds the "Save as PDF" default filename.
            operation.setJobTitle(Some(&NSString::from_str(job_title)));
        }
        operation.setShowsPrintPanel(true);
        // Keep the panel and any "Save as PDF" write on this (main) thread so
        // `runOperation` returns only AFTER the user is fully done -- the caller
        // closes the helper immediately after, and a spawned thread would race
        // that teardown.
        operation.setCanSpawnSeparateThread(false);
        operation.runOperation();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_is_empty_when_nothing_pending() {
        let state = PendingPrintHtml::default();
        assert!(state.body().is_empty());
    }

    #[test]
    fn body_returns_the_stashed_html() {
        let state = PendingPrintHtml::default();
        state.set(Some("<h1>hi</h1>".to_string()));
        assert_eq!(state.body(), b"<h1>hi</h1>".to_vec());
    }

    #[test]
    fn set_round_trip_then_clear() {
        let state = PendingPrintHtml::default();
        state.set(Some("<p>doc</p>".to_string()));
        assert_eq!(state.body(), b"<p>doc</p>".to_vec());
        // body clones, not drains: a re-read still returns it until cleared.
        assert_eq!(state.body(), b"<p>doc</p>".to_vec());
        // teardown clears it
        state.set(None);
        assert!(state.body().is_empty());
    }

    #[test]
    fn resolve_window_title_uses_the_doc_title() {
        assert_eq!(resolve_window_title("notes"), "notes");
    }

    #[test]
    fn resolve_window_title_trims_whitespace() {
        assert_eq!(resolve_window_title("  notes  "), "notes");
    }

    #[test]
    fn resolve_window_title_falls_back_when_blank() {
        assert_eq!(resolve_window_title(""), "Exporting to PDF…");
        assert_eq!(resolve_window_title("   "), "Exporting to PDF…");
    }
}
