//! Rust-owned per-APP preferences file: `app_config_dir()/settings.json`.
//!
//! Settings (theme, typography, editor behavior, export format, open mode) are
//! editor preferences, so they live per-app — NOT per-workspace — in a single
//! file all instances share. The frontend (src/lib/settings.ts) keeps
//! localStorage only as a synchronous boot cache and treats this file as the
//! source of truth: it reconciles from `load_prefs` after mount and on window
//! focus, and persists every change through `save_prefs`. Writes are atomic
//! (tempfile + rename via history.rs's `atomic_write`), so two instances
//! saving concurrently is last-writer-wins on the WHOLE file but never torn;
//! the loser converges on its next focus re-read.
//!
//! The path is Rust-owned (mirrors workspace.rs's `state_file`) — the webview
//! never names it, so the "IPC only touches user-picked paths" allowlist
//! invariant is untouched. Rust stays schema-agnostic: `validate_prefs` only
//! caps size and requires a JSON object; the frontend's tolerant
//! `parseSettings` remains the schema authority.
//!
//! Per-WORKSPACE state lives in the per-workspace state DIRECTORY
//! `app_data_dir()/workspace-state/<sha256hex(canonical root)>/` (keys via
//! history.rs's `bucket_key`). History is one tenant, at
//! `<hash>/history/<sha256hex(canonical file path)>/` — see history.rs; the
//! last-open-file pointer is the other, at `<hash>/ui.json` — see
//! workspace.rs's `save_workspace_ui`/`load_workspace_ui`. Future
//! per-workspace JSON state (open-files list, expanded folders) belongs in
//! more `<hash>/*.json` files. This directory layout supersedes the
//! older single-`<hash>.json` sketch, and makes "clear history for this
//! workspace = delete one directory" newly tractable (not built this
//! sprint). Chosen over a `.markdon/` dot-dir inside the workspace: that
//! would pollute user repos, invite cloud-sync conflicts, and widen the
//! guarded-write surface into user folders.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::history::atomic_write;

/// Upper bound on the stored JSON. The real settings blob is a few hundred
/// bytes; the cap only stops a compromised webview using the file as an
/// arbitrary-size disk sink.
const MAX_PREFS_BYTES: usize = 64 * 1024;

/// Path of the settings file, creating the config dir if needed. Rust-owned so
/// the webview can never supply it — mirrors `workspace.rs::state_file`.
fn prefs_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Shape gate for webview-supplied prefs: size-capped, parseable JSON, and an
/// object at the top level. Deliberately nothing more — field-level validation
/// belongs to the frontend's `parseSettings`.
pub(crate) fn validate_prefs(json: &str) -> Result<(), String> {
    if json.len() > MAX_PREFS_BYTES {
        return Err("settings too large".into());
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("settings must be a JSON object".into());
    }
    Ok(())
}

/// Read the stored prefs. Missing file -> `None` (first run); any other I/O
/// failure is a real error. Takes `&Path` so it is testable without an
/// AppHandle.
pub(crate) fn load_prefs_from(file: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Validate then atomically replace the stored prefs.
pub(crate) fn save_prefs_to(file: &Path, json: &str) -> Result<(), String> {
    validate_prefs(json)?;
    atomic_write(file, json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_prefs(app: AppHandle) -> Result<Option<String>, String> {
    load_prefs_from(&prefs_file(&app)?)
}

#[tauri::command]
pub fn save_prefs(json: String, app: AppHandle) -> Result<(), String> {
    save_prefs_to(&prefs_file(&app)?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_missing_file_is_none() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("settings.json");
        assert_eq!(load_prefs_from(&file).unwrap(), None);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("settings.json");
        save_prefs_to(&file, r#"{"version":1,"theme":"dark"}"#).unwrap();
        assert_eq!(
            load_prefs_from(&file).unwrap().as_deref(),
            Some(r#"{"version":1,"theme":"dark"}"#)
        );
    }

    #[test]
    fn overwrite_replaces_content() {
        // Atomic rename semantics: after each save the file reads back exactly
        // as the LAST write, never a blend or truncation.
        let dir = tempdir().unwrap();
        let file = dir.path().join("settings.json");
        save_prefs_to(&file, r#"{"a":1}"#).unwrap();
        save_prefs_to(&file, r#"{"b":2}"#).unwrap();
        assert_eq!(
            load_prefs_from(&file).unwrap().as_deref(),
            Some(r#"{"b":2}"#)
        );
    }

    #[test]
    fn validate_rejects_oversized_payload() {
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_PREFS_BYTES));
        assert!(validate_prefs(&big).is_err());
    }

    #[test]
    fn validate_rejects_non_json() {
        assert!(validate_prefs("not json{{{").is_err());
        assert!(validate_prefs("").is_err());
    }

    #[test]
    fn validate_rejects_non_object_json() {
        assert!(validate_prefs("42").is_err());
        assert!(validate_prefs("\"hi\"").is_err());
        assert!(validate_prefs("null").is_err());
        assert!(validate_prefs("[1,2]").is_err());
    }

    #[test]
    fn validate_accepts_an_object() {
        assert!(validate_prefs("{}").is_ok());
        assert!(validate_prefs(r#"{"version":1}"#).is_ok());
    }

    #[test]
    fn save_rejects_invalid_payload_without_touching_the_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("settings.json");
        save_prefs_to(&file, r#"{"keep":true}"#).unwrap();
        assert!(save_prefs_to(&file, "42").is_err());
        assert_eq!(
            load_prefs_from(&file).unwrap().as_deref(),
            Some(r#"{"keep":true}"#)
        );
    }
}
