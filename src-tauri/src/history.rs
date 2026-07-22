//! App-managed local version store (NOT git). Every successful save — plus
//! silent external reloads and the pre-revert snapshot — records the just-written
//! file content into an app-owned store under `app_data_dir()`.
//!
//! Layout: `app_data_dir()/history/<sha256hex(canonical abs path)>/` holds one
//! `<timestamp-ms>.md` per version plus an `index.json` describing them. The
//! bucket key is derived in Rust by canonicalizing the ensure()'d path and
//! hashing the string, so symlink/alias aliases collapse to one bucket and the
//! webview can never name a store path.
//!
//! SECURITY: only the user file path is routed through `AllowedPaths::ensure`;
//! history-internal paths are always built with `PathBuf::join` under
//! `app_data_dir` and NEVER passed through `reject_unsafe_path` (a canonical
//! Windows path carries the `\\?\` verbatim prefix that guard rejects). Version
//! ids supplied by the webview are validated (`valid_id`) AND membership-checked
//! against the index before any file is read.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::allowlist::AllowedPaths;

/// Per-canonical-path lock guarding `record_snapshot`'s read-modify-write of a
/// bucket's `index.json` (load_index -> mutate -> write_index). Per-PROCESS
/// only, deliberately: two app INSTANCES snapshotting the same file can still
/// race the index and drop one entry (its `<ts>.md` is orphaned, never
/// corrupted — `atomic_write` and the tolerant `load_index` see to that).
/// A cross-process flock isn't worth the platform-specific machinery for a
/// worst case of one lost history entry.
///
/// Within one process the lock is load-bearing: without it,
/// two `record_history` invocations racing for the SAME file (a fast double
/// save, or a save overlapping a recordExternal/recordRevert call) can each
/// load the same stale index and append independently; the later
/// `write_index` overwrites the earlier one, silently dropping that entry
/// from the index while its `<ts>.md` content file is orphaned on disk.
/// Tauri commands run on a blocking thread pool, so this is a real race, not
/// a hypothetical one. Keyed by canonical path rather than bucket hash so a
/// lock-map inspection stays legible; the outer map's own mutex is only ever
/// held for the felt-instant get-or-insert, never across an index read/write.
#[derive(Default)]
pub struct HistoryLocks(Mutex<HashMap<String, Arc<Mutex<()>>>>);

impl HistoryLocks {
    /// Returns the (possibly newly created) lock for `canonical`. Callers must
    /// hold the returned lock for the full duration of their read-modify-write
    /// of that path's bucket.
    fn lock_for(&self, canonical: &str) -> Arc<Mutex<()>> {
        let mut map = self.0.lock().unwrap();
        map.entry(canonical.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

/// Keep at most this many newest versions per file.
const MAX_VERSIONS: usize = 50;
/// Drop versions older than this many days …
const MAX_AGE_DAYS: u64 = 30;
/// … except always keep the newest this-many, so a rarely-edited file is never
/// wiped by the age rule.
const MIN_KEEP: usize = 10;

/// One recorded version. `id` is the on-disk filename (also the stable handle the
/// webview passes back to `read_history_version`); `ts` is UNIX-epoch millis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub ts: u64,
    pub size: u64,
    pub hash: String,
    pub preview: String,
    pub trigger: String,
}

/// The per-bucket `index.json`. Entries are stored oldest-first (append order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub version: u32,
    pub path: String,
    pub entries: Vec<Entry>,
}

impl Default for Index {
    fn default() -> Self {
        Index {
            version: 1,
            path: String::new(),
            entries: Vec::new(),
        }
    }
}

fn sha256hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Bucket directory name for a canonical absolute path: `sha256hex(path)`.
pub(crate) fn bucket_key(canonical: &str) -> String {
    sha256hex(canonical.as_bytes())
}

fn bucket_dir_in(base: &Path, canonical: &str) -> PathBuf {
    base.join("history").join(bucket_key(canonical))
}

/// A one-line preview: the first ATX heading (`# …`) if any, else the first ~80
/// non-empty characters (whitespace collapsed). Char-based truncation keeps it
/// UTF-8 safe.
pub(crate) fn extract_preview(content: &str) -> String {
    for line in content.lines() {
        if let Some(h) = atx_heading(line) {
            if !h.is_empty() {
                return h.chars().take(80).collect();
            }
        }
    }
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(80).collect()
}

/// Text of an ATX heading (`#`..`######` followed by a space), or None.
fn atx_heading(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let hashes = t.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) {
        return t[hashes..].strip_prefix(' ').map(str::trim);
    }
    None
}

/// A version id is `\d+.md` or `\d+-\d+.md` (a same-millisecond collision gets a
/// `-N` suffix). Any path separator, `..`, empty stem, or non-`.md` extension
/// makes a non-digit appear in a segment and is rejected — this is the trust
/// boundary that stops a compromised webview naming an arbitrary store file.
pub(crate) fn valid_id(id: &str) -> bool {
    let Some(stem) = id.strip_suffix(".md") else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    let mut parts = stem.splitn(2, '-');
    let first = parts.next().unwrap();
    if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if let Some(second) = parts.next() {
        if second.is_empty() || !second.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    true
}

/// A unique id for a new entry at `now_ms`. The common case is `<ms>.md`; two
/// different-content saves inside one millisecond get `<ms>-1.md`, `<ms>-2.md`, …
/// so ids (and their filenames) never collide.
fn unique_id(entries: &[Entry], now_ms: u64) -> String {
    let base = format!("{now_ms}.md");
    if !entries.iter().any(|e| e.id == base) {
        return base;
    }
    let mut n = 1u64;
    loop {
        let cand = format!("{now_ms}-{n}.md");
        if !entries.iter().any(|e| e.id == cand) {
            return cand;
        }
        n += 1;
    }
}

/// Retention: keep the newest `MAX_VERSIONS`, then drop anything older than
/// `MAX_AGE_DAYS` EXCEPT always keep the newest `MIN_KEEP`. `entries` must be
/// oldest-first; survivors stay in place and the removed entries are returned so
/// the caller can delete their snapshot files.
pub(crate) fn prune(entries: &mut Vec<Entry>, now_ms: u64) -> Vec<Entry> {
    let max_age_ms = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let cutoff = now_ms.saturating_sub(max_age_ms);
    let total = entries.len();
    let over = total.saturating_sub(MAX_VERSIONS);
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for (i, e) in entries.drain(..).enumerate() {
        let from_newest = total - 1 - i; // 0 == newest
        let beyond_max = i < over; // among the oldest past MAX_VERSIONS
        let too_old = e.ts < cutoff && from_newest >= MIN_KEEP;
        if beyond_max || too_old {
            removed.push(e);
        } else {
            kept.push(e);
        }
    }
    *entries = kept;
    removed
}

/// Write via temp file + rename so a crash mid-write never leaves a truncated
/// snapshot or index. Replicates commands.rs's atomic pattern (NOT its guarded
/// write_file wrapper, which would reject the store's internal paths).
/// `pub(crate)` so prefs.rs reuses it for the settings file instead of
/// duplicating the tempfile+persist dance.
pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn index_path(bucket: &Path) -> PathBuf {
    bucket.join("index.json")
}

/// Load a bucket's index, tolerating a missing or corrupt file (returns an empty
/// index either way, so a garbled index never breaks a save).
fn load_index(bucket: &Path) -> Index {
    match fs::read(index_path(bucket)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Index::default(),
    }
}

fn write_index(bucket: &Path, index: &Index) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    atomic_write(&index_path(bucket), &json).map_err(|e| e.to_string())
}

/// Core snapshot logic, testable without an AppHandle: `base` stands in for
/// `app_data_dir()`. Content-deduped against the newest entry (a save with no
/// change writes nothing), then pruned. Returns the new entry id, or None when
/// deduped.
pub(crate) fn record_snapshot(
    base: &Path,
    canonical: &str,
    content: &str,
    trigger: &str,
    now_ms: u64,
) -> Result<Option<String>, String> {
    let bucket = bucket_dir_in(base, canonical);
    fs::create_dir_all(&bucket).map_err(|e| e.to_string())?;
    let mut index = load_index(&bucket);
    let hash = sha256hex(content.as_bytes());
    if index
        .entries
        .last()
        .map(|e| e.hash == hash)
        .unwrap_or(false)
    {
        return Ok(None); // no change since the latest version
    }
    let id = unique_id(&index.entries, now_ms);
    atomic_write(&bucket.join(&id), content.as_bytes()).map_err(|e| e.to_string())?;
    index.entries.push(Entry {
        id: id.clone(),
        ts: now_ms,
        size: content.len() as u64,
        hash,
        preview: extract_preview(content),
        trigger: trigger.to_string(),
    });
    for e in prune(&mut index.entries, now_ms) {
        let _ = fs::remove_file(bucket.join(&e.id));
    }
    index.version = 1;
    index.path = canonical.to_string();
    write_index(&bucket, &index)?;
    Ok(Some(id))
}

/// Metadata list for a bucket, newest-first (empty if no history yet).
pub(crate) fn list_snapshots(base: &Path, canonical: &str) -> Vec<Entry> {
    let bucket = bucket_dir_in(base, canonical);
    let mut index = load_index(&bucket);
    index.entries.reverse();
    index.entries
}

/// Read one version's content. `id` must pass `valid_id` AND be a known entry in
/// the index — both checks are mandatory (a compromised webview must not read an
/// arbitrary store file by naming it).
pub(crate) fn read_snapshot(base: &Path, canonical: &str, id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("bad version id".into());
    }
    let bucket = bucket_dir_in(base, canonical);
    let index = load_index(&bucket);
    if !index.entries.iter().any(|e| e.id == id) {
        return Err("unknown version".into());
    }
    fs::read_to_string(bucket.join(id)).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Canonicalize the ensure()'d user path (collapsing symlink/alias variants) so
/// the same file always maps to one bucket regardless of how it was reached.
fn ensured_canonical(path: &str, allowed: &AllowedPaths) -> Result<String, String> {
    allowed.ensure(path)?;
    let canon = fs::canonicalize(path).map_err(|e| e.to_string())?;
    Ok(canon.to_string_lossy().into_owned())
}

fn history_base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Snapshot the current on-disk content of `path`. Best-effort from the
/// frontend's side (a failure here must never fail a save): Rust re-reads the
/// just-written file itself — content is NOT supplied by the webview — so the
/// store is always the single source of truth for what landed on disk.
#[tauri::command]
pub fn record_history(
    path: String,
    trigger: String,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
    locks: State<'_, HistoryLocks>,
) -> Result<(), String> {
    let canonical = ensured_canonical(&path, &allowed)?;
    // Held for the entire read-modify-write below so a concurrent
    // record_history for the same file can't interleave and lose an entry
    // (see HistoryLocks's doc comment).
    let lock = locks.lock_for(&canonical);
    let _held = lock.lock().unwrap();
    let content = fs::read_to_string(&canonical).map_err(|e| e.to_string())?;
    let base = history_base(&app)?;
    record_snapshot(&base, &canonical, &content, &trigger, now_ms())?;
    Ok(())
}

#[tauri::command]
pub fn list_history(
    path: String,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<Vec<Entry>, String> {
    let canonical = ensured_canonical(&path, &allowed)?;
    let base = history_base(&app)?;
    Ok(list_snapshots(&base, &canonical))
}

#[tauri::command]
pub fn read_history_version(
    path: String,
    id: String,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    let canonical = ensured_canonical(&path, &allowed)?;
    let base = history_base(&app)?;
    read_snapshot(&base, &canonical, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn entry(id: &str, ts: u64) -> Entry {
        Entry {
            id: id.to_string(),
            ts,
            size: 1,
            hash: format!("hash-{id}"),
            preview: String::new(),
            trigger: "save".into(),
        }
    }

    // -- bucket_key ---------------------------------------------------------

    #[test]
    fn bucket_key_is_deterministic_hex64() {
        let k = bucket_key("/Users/me/notes/a.md");
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(k, bucket_key("/Users/me/notes/a.md"));
        assert_ne!(k, bucket_key("/Users/me/notes/b.md"));
    }

    // -- extract_preview ----------------------------------------------------

    #[test]
    fn preview_uses_first_atx_heading() {
        assert_eq!(extract_preview("# Title\n\nbody"), "Title");
        assert_eq!(extract_preview("intro\n\n## Section two\nx"), "Section two");
        assert_eq!(extract_preview("   ###   Spaced   \n"), "Spaced");
    }

    #[test]
    fn preview_falls_back_to_first_nonempty_chars() {
        assert_eq!(extract_preview("\n\n  hello   world  \n"), "hello world");
        assert_eq!(extract_preview(""), "");
        // Seven `#` is not a valid ATX heading -> fall through to text.
        assert_eq!(extract_preview("####### too deep"), "####### too deep");
    }

    #[test]
    fn preview_truncates_to_80_chars() {
        let long = "a ".repeat(100); // 100 "a" tokens
        let p = extract_preview(&long);
        assert_eq!(p.chars().count(), 80);
    }

    // -- valid_id -----------------------------------------------------------

    #[test]
    fn valid_id_accepts_timestamp_and_counter_forms() {
        assert!(valid_id("1712345678901.md"));
        assert!(valid_id("1712345678901-3.md"));
    }

    #[test]
    fn valid_id_rejects_traversal_and_junk() {
        assert!(!valid_id("../x.md"));
        assert!(!valid_id("a/b.md"));
        assert!(!valid_id(".."));
        assert!(!valid_id("1712.txt"));
        assert!(!valid_id(""));
        assert!(!valid_id(".md"));
        assert!(!valid_id("12-.md"));
        assert!(!valid_id("12-3-4.md"));
        assert!(!valid_id("1e3.md"));
    }

    // -- prune --------------------------------------------------------------

    #[test]
    fn prune_keeps_newest_max_versions() {
        let now = 100 * DAY_MS;
        // 55 recent entries (none age-expired): oldest 5 dropped, 50 kept.
        let mut entries: Vec<Entry> = (0..55).map(|i| entry(&format!("{i}.md"), now)).collect();
        let removed = prune(&mut entries, now);
        assert_eq!(entries.len(), 50);
        assert_eq!(removed.len(), 5);
        assert_eq!(removed[0].id, "0.md");
        assert_eq!(entries.first().unwrap().id, "5.md");
    }

    #[test]
    fn prune_drops_old_but_keeps_min_newest() {
        let now = 100 * DAY_MS;
        let old = now - 40 * DAY_MS; // older than 30 days
                                     // 15 entries, all ancient. Newest MIN_KEEP(10) survive by the age rule.
        let mut entries: Vec<Entry> = (0..15).map(|i| entry(&format!("{i}.md"), old)).collect();
        let removed = prune(&mut entries, now);
        assert_eq!(entries.len(), MIN_KEEP);
        assert_eq!(removed.len(), 5);
        assert_eq!(entries.first().unwrap().id, "5.md"); // kept newest 10
    }

    #[test]
    fn prune_keeps_recent_entries_untouched() {
        let now = 100 * DAY_MS;
        let mut entries: Vec<Entry> = (0..12).map(|i| entry(&format!("{i}.md"), now)).collect();
        let removed = prune(&mut entries, now);
        assert!(removed.is_empty());
        assert_eq!(entries.len(), 12);
    }

    #[test]
    fn prune_mixed_age_drops_only_old_beyond_min_keep() {
        let now = 100 * DAY_MS;
        let old = now - 40 * DAY_MS;
        // 12 entries: first 2 ancient, rest recent. Only the 2 ancient ones sit
        // outside the newest-10 window, so both are dropped.
        let mut entries = Vec::new();
        entries.push(entry("0.md", old));
        entries.push(entry("1.md", old));
        for i in 2..12 {
            entries.push(entry(&format!("{i}.md"), now));
        }
        let removed = prune(&mut entries, now);
        assert_eq!(removed.len(), 2);
        assert_eq!(entries.len(), 10);
        assert_eq!(entries.first().unwrap().id, "2.md");
    }

    // -- Index serde --------------------------------------------------------

    #[test]
    fn index_serde_round_trips() {
        let idx = Index {
            version: 1,
            path: "/x/y.md".into(),
            entries: vec![entry("1.md", 5)],
        };
        let json = serde_json::to_vec(&idx).unwrap();
        let back: Index = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.path, "/x/y.md");
        assert_eq!(back.entries, idx.entries);
    }

    #[test]
    fn load_index_tolerates_missing_and_corrupt() {
        let dir = tempdir().unwrap();
        // Missing file -> empty index.
        assert!(load_index(dir.path()).entries.is_empty());
        // Corrupt file -> empty index, not a panic.
        fs::write(index_path(dir.path()), b"{not json").unwrap();
        assert!(load_index(dir.path()).entries.is_empty());
    }

    // -- record / read integration (base dir stands in for app_data_dir) ----

    #[test]
    fn record_writes_snapshot_and_index() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        let id = record_snapshot(base.path(), canonical, "# One", "save", 1000)
            .unwrap()
            .expect("first record writes a snapshot");
        let bucket = bucket_dir_in(base.path(), canonical);
        assert!(bucket.join(&id).exists());
        assert!(index_path(&bucket).exists());
        let list = list_snapshots(base.path(), canonical);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].preview, "One");
        assert_eq!(list[0].trigger, "save");
        assert_eq!(list[0].size, "# One".len() as u64);
    }

    #[test]
    fn record_dedupes_identical_content() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        record_snapshot(base.path(), canonical, "same", "save", 1000).unwrap();
        let second = record_snapshot(base.path(), canonical, "same", "save", 2000).unwrap();
        assert!(second.is_none(), "identical content must not snapshot");
        assert_eq!(list_snapshots(base.path(), canonical).len(), 1);
    }

    #[test]
    fn record_appends_on_change_and_lists_newest_first() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        record_snapshot(base.path(), canonical, "v1", "save", 1000).unwrap();
        record_snapshot(base.path(), canonical, "v2", "save", 2000).unwrap();
        let list = list_snapshots(base.path(), canonical);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].ts, 2000); // newest first
        assert_eq!(list[1].ts, 1000);
    }

    #[test]
    fn record_prunes_and_deletes_pruned_snapshot_files() {
        let base = tempdir().unwrap();
        let canonical = "/docs/big.md";
        let bucket = bucket_dir_in(base.path(), canonical);
        // 60 distinct-content saves; retention caps at 50 and deletes the files.
        for i in 0..60 {
            record_snapshot(
                base.path(),
                canonical,
                &format!("content {i}"),
                "save",
                1000 + i,
            )
            .unwrap();
        }
        let list = list_snapshots(base.path(), canonical);
        assert_eq!(list.len(), 50);
        // The 10 oldest snapshot files must be gone from disk, not just the index.
        let md_files = fs::read_dir(&bucket)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            .count();
        assert_eq!(md_files, 50);
    }

    #[test]
    fn same_millisecond_saves_get_distinct_ids() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        let a = record_snapshot(base.path(), canonical, "one", "save", 1000)
            .unwrap()
            .unwrap();
        let b = record_snapshot(base.path(), canonical, "two", "save", 1000)
            .unwrap()
            .unwrap();
        assert_ne!(a, b, "two saves in one ms must not share an id/filename");
        assert!(valid_id(&a) && valid_id(&b));
        let bucket = bucket_dir_in(base.path(), canonical);
        assert_eq!(fs::read_to_string(bucket.join(&a)).unwrap(), "one");
        assert_eq!(fs::read_to_string(bucket.join(&b)).unwrap(), "two");
    }

    #[test]
    fn read_snapshot_returns_content_for_known_id() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        let id = record_snapshot(base.path(), canonical, "# Hello", "save", 1000)
            .unwrap()
            .unwrap();
        assert_eq!(
            read_snapshot(base.path(), canonical, &id).unwrap(),
            "# Hello"
        );
    }

    #[test]
    fn read_snapshot_rejects_unknown_id() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        record_snapshot(base.path(), canonical, "x", "save", 1000).unwrap();
        // Well-formed but not in the index.
        assert!(read_snapshot(base.path(), canonical, "9999.md").is_err());
    }

    // -- HistoryLocks ---------------------------------------------------------

    #[test]
    fn lock_for_returns_same_lock_for_same_path_distinct_for_others() {
        let locks = HistoryLocks::default();
        let a1 = locks.lock_for("/docs/a.md");
        let a2 = locks.lock_for("/docs/a.md");
        assert!(
            Arc::ptr_eq(&a1, &a2),
            "same canonical path must share one lock"
        );
        let b = locks.lock_for("/docs/b.md");
        assert!(
            !Arc::ptr_eq(&a1, &b),
            "different canonical paths must get distinct locks"
        );
    }

    #[test]
    fn concurrent_records_for_same_file_under_the_lock_lose_no_entries() {
        // Regression for the lost-update race: record_snapshot's
        // load_index -> mutate -> write_index is NOT internally synchronized
        // (by design -- it's a pure, testable function), so callers racing
        // for the SAME bucket must serialize around it themselves. This
        // spawns many threads that each hold `HistoryLocks::lock_for` (what
        // the record_history command now does) across their own
        // record_snapshot call, and asserts every one of their distinct-
        // content saves survives in the index -- none silently overwritten
        // by a sibling's stale read-modify-write.
        let base = tempdir().unwrap();
        let base_path = base.path().to_path_buf();
        let canonical = "/docs/race.md";
        let locks = Arc::new(HistoryLocks::default());

        let handles: Vec<_> = (0..16)
            .map(|i| {
                let base_path = base_path.clone();
                let locks = Arc::clone(&locks);
                std::thread::spawn(move || {
                    let lock = locks.lock_for(canonical);
                    let _held = lock.lock().unwrap();
                    record_snapshot(
                        &base_path,
                        canonical,
                        &format!("content {i}"),
                        "save",
                        1000 + i as u64,
                    )
                    .unwrap()
                    .expect("distinct content must always snapshot")
                })
            })
            .collect();

        let mut ids: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 16, "every concurrent save must get a unique id");

        let list = list_snapshots(&base_path, canonical);
        assert_eq!(
            list.len(),
            16,
            "no entry may be lost to a racing read-modify-write"
        );
    }

    #[test]
    fn read_snapshot_rejects_traversal_id_even_if_file_exists() {
        let base = tempdir().unwrap();
        let canonical = "/docs/a.md";
        record_snapshot(base.path(), canonical, "x", "save", 1000).unwrap();
        let bucket = bucket_dir_in(base.path(), canonical);
        // Plant a secret one level up from the bucket and try to escape to it.
        let secret = bucket.parent().unwrap().join("secret.md");
        fs::write(&secret, "TOP SECRET").unwrap();
        assert!(read_snapshot(base.path(), canonical, "../secret.md").is_err());
    }
}
