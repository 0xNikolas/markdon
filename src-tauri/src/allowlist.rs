use std::collections::HashSet;
use std::sync::Mutex;

/// Paths the webview is allowed to read/write/watch. Only Rust ever inserts:
/// file-dialog picks and OS open events. The webview can therefore only touch
/// paths the user explicitly granted, even if it is fully compromised.
/// Exact-string matching suffices because every accepted value is a string this
/// process produced itself.
#[derive(Default)]
pub struct AllowedPaths(Mutex<HashSet<String>>);

impl AllowedPaths {
    pub fn allow(&self, path: &str) {
        self.0.lock().unwrap().insert(path.to_string());
    }

    pub fn ensure(&self, path: &str) -> Result<(), String> {
        if self.0.lock().unwrap().contains(path) {
            Ok(())
        } else {
            Err("path was not granted by a file dialog or OS open event".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_rejects_unknown_path() {
        let a = AllowedPaths::default();
        assert!(a.ensure("/tmp/x.md").is_err());
    }

    #[test]
    fn ensure_accepts_allowed_path_exactly() {
        let a = AllowedPaths::default();
        a.allow("/tmp/x.md");
        assert!(a.ensure("/tmp/x.md").is_ok());
        assert!(
            a.ensure("/tmp/x.md/../y.md").is_err(),
            "no path algebra: exact strings only"
        );
    }
}
