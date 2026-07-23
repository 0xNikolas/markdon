//! Shared IPC-error plumbing: every `#[tauri::command]` surfaces errors to the
//! webview as a `String`.

/// The Result shape every fallible command (and the impl functions behind them)
/// returns: `Ok` value, or a human-readable `String` for the webview.
pub(crate) type CmdResult<T> = Result<T, String>;

/// `.se()` = "stringify error": the ubiquitous `.map_err(|e| e.to_string())` as
/// a single call, for any error type that implements `Display`. Deliberately
/// does NOT cover the sites that map to a FIXED message (`.map_err(|_| …)`) or
/// to an inner field (`.map_err(|e| e.error)`) — those carry intent beyond a
/// plain stringify and stay spelled out.
pub(crate) trait SeExt<T> {
    fn se(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> SeExt<T> for Result<T, E> {
    fn se(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}
