//! PDF export via the native macOS print panel.
//!
//! There is no honest silent direct-to-file PDF API available to us: wry 0.55
//! surfaces only the native print panel (NSPrintOperation) and WKWebView's
//! `createPDFWithConfiguration:` is not exposed through tauri. So "export to
//! PDF" routes through the OS print dialog, whose built-in "Save as PDF"
//! affordance writes the file -- the app never shows its own save dialog.
//!
//! Mechanism: the frontend builds the SAME clean, light-token standalone HTML
//! the HTML export produces (buildExportHtml) and hands it here. We stash it,
//! open a short-lived borderless helper window covering the main window, and
//! load it via the `pdfprint://` custom scheme (WebviewUrl has no raw-HTML
//! variant, and wry rejects `data:` URLs for navigation). A document-start
//! user script (`initialization_script` -- a WKUserScript, NOT a page
//! `<script>`, so unaffected by the CSP `script-src 'self'`) calls
//! `window.print()` on load and closes the helper window on the DOM
//! `afterprint` event. Printing the helper -- not the main window -- keeps app
//! chrome (header, sidebar, split panes, dark theme) out of the PDF, so the
//! artifact matches the HTML export exactly.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// HTML awaiting pickup by the `pdfprint://` scheme handler. Stashed here
/// because `WebviewUrl` has no raw-HTML variant; the handler drains it when the
/// helper window loads. Cleared on teardown so document content does not linger.
#[derive(Default)]
pub struct PendingPrintHtml(pub Mutex<Option<String>>);

/// Label of the ephemeral print window; also the URI-scheme authority host.
pub const PRINT_WINDOW_LABEL: &str = "pdf-print";

/// Document-start bootstrap injected into the helper window. Runs before page
/// scripts as a WKUserScript, so the page CSP does not gate it. On load it
/// opens the native print panel; on `afterprint` (panel dismissed) it closes
/// the helper via the `close_pdf_export` command. `Escape` is a manual fallback
/// so the borderless window can never get stuck if `afterprint` fails to fire,
/// and a `window.print()` that throws closes immediately.
const PRINT_BOOTSTRAP: &str = "\
addEventListener('load',function(){\
var close=function(){window.__TAURI_INTERNALS__.invoke('close_pdf_export');};\
addEventListener('afterprint',close);\
addEventListener('keydown',function(e){if(e.key==='Escape')close();});\
try{window.print();}catch(e){close();}\
});";

/// Stash the export HTML and open the helper print window over the main window.
/// Returns immediately: the native print panel is presented as a sheet and the
/// helper tears itself down from JS (see `PRINT_BOOTSTRAP` / `close_pdf_export`).
#[tauri::command]
pub async fn export_pdf(app: AppHandle, html: String) -> Result<(), String> {
    *app.state::<PendingPrintHtml>().0.lock().unwrap() = Some(html);

    // A prior export that was never dismissed could still have a helper around.
    if let Some(existing) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = existing.close();
    }

    let url = "pdfprint://localhost/"
        .parse()
        .map_err(|_| "invalid pdfprint url".to_string())?;
    let mut builder =
        WebviewWindowBuilder::new(&app, PRINT_WINDOW_LABEL, WebviewUrl::CustomProtocol(url))
            .title("Exporting to PDF…")
            .decorations(false)
            .visible(true)
            .initialization_script(PRINT_BOOTSTRAP);

    // Cover the main window (same logical position/size) so the print sheet
    // appears to drop from the app itself rather than from a stray window.
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(scale) = main.scale_factor() {
            if let Ok(pos) = main.outer_position() {
                let p = pos.to_logical::<f64>(scale);
                builder = builder.position(p.x, p.y);
            }
            if let Ok(size) = main.inner_size() {
                let s = size.to_logical::<f64>(scale);
                builder = builder.inner_size(s.width, s.height);
            }
        }
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the helper print window and drop the stashed HTML. Invoked from the
/// helper's `afterprint`/`Escape` handler; a no-op if the window is already gone.
#[tauri::command]
pub fn close_pdf_export(app: AppHandle) {
    if let Some(window) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        let _ = window.close();
    }
    *app.state::<PendingPrintHtml>().0.lock().unwrap() = None;
}

/// Body served by the `pdfprint://` scheme handler: the stashed export HTML, or
/// an empty document when nothing is pending. Pure so it is unit-testable
/// without a running webview.
pub fn pending_print_body(state: &PendingPrintHtml) -> Vec<u8> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default()
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_is_empty_when_nothing_pending() {
        let state = PendingPrintHtml::default();
        assert!(pending_print_body(&state).is_empty());
    }

    #[test]
    fn body_returns_the_stashed_html() {
        let state = PendingPrintHtml::default();
        *state.0.lock().unwrap() = Some("<h1>hi</h1>".to_string());
        assert_eq!(pending_print_body(&state), b"<h1>hi</h1>".to_vec());
    }

    #[test]
    fn stash_take_round_trip_then_clear() {
        let state = PendingPrintHtml::default();
        *state.0.lock().unwrap() = Some("<p>doc</p>".to_string());
        assert_eq!(pending_print_body(&state), b"<p>doc</p>".to_vec());
        // teardown clears it
        *state.0.lock().unwrap() = None;
        assert!(pending_print_body(&state).is_empty());
    }
}
