use std::path::PathBuf;
use std::sync::Mutex;

/// What the process was asked to do via its command line: an optional
/// `--workspace <dir>` to adopt on startup, plus positional file paths to open.
/// This is how a "new app instance" hand-off works — the spawning process
/// (`pick_folder_new_instance` / `open_file_new_instance`) re-execs
/// `current_exe()` with these args, and the child adopts them here instead of
/// through any cross-process IPC.
#[derive(Debug, PartialEq)]
pub struct LaunchArgs {
    pub workspace: Option<PathBuf>,
    pub files: Vec<PathBuf>,
}

impl LaunchArgs {
    /// True when this launch was HANDED OFF work — a `--workspace` dir and/or
    /// positional files. A handed-off child must never fall back to restoring
    /// the persisted last-workspace pointer (that pointer belongs to the
    /// SPAWNER), and it also skips restoring the shared window geometry.
    /// A cold launch (empty argv, e.g. Finder starting the app) is not a
    /// hand-off and keeps both restore behaviors.
    pub fn is_handoff(&self) -> bool {
        self.workspace.is_some() || !self.files.is_empty()
    }
}

/// Parse process arguments (WITHOUT the leading program name — callers pass
/// `std::env::args().skip(1)`). Rules:
/// - `--workspace <dir>` captures the next arg as the startup workspace (last
///   occurrence wins; a trailing bare `--workspace` is ignored). The dir is NOT
///   validated here — `take_startup_workspace` fail-softs via `allow_root`.
/// - every other arg is a positional file candidate, kept only if it names an
///   existing regular file. That one filter drops both typos and launcher junk
///   (e.g. macOS's legacy `-psn_…` flag) without needing a flag grammar.
pub fn parse_launch_args(args: &[String]) -> LaunchArgs {
    let mut workspace = None;
    let mut files = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--workspace" {
            if let Some(dir) = it.next() {
                workspace = Some(PathBuf::from(dir));
            }
        } else {
            let p = PathBuf::from(arg);
            if p.is_file() {
                files.push(p);
            }
        }
    }
    LaunchArgs { workspace, files }
}

/// The `--workspace` dir parsed from argv, held until the frontend claims it.
/// Managed state (not a local in `run()`) because the claim happens later, from
/// the webview's `take_startup_workspace` call on mount. Take-once semantics
/// mirror `OpenedFiles`/`PendingWindowFile`: a re-mount must not re-adopt.
/// Lock poisoning is unwrap()'d fail-fast per the policy note in lib.rs.
///
/// `suppress_restore` rides alongside, NON-consumed (reading it never clears
/// anything): it records `LaunchArgs::is_handoff()` at construction, so even
/// after the dir is taken — or when it was never adoptable (vanished, or a
/// files-only hand-off with no `--workspace` at all) — the frontend can still
/// tell "handed-off child, start folder-less" from "cold launch, restore the
/// last folder". Without it, a fail-soft `None` was indistinguishable from a
/// cold launch and a child silently adopted its SPAWNER's persisted folder.
#[derive(Default)]
pub struct StartupWorkspace {
    dir: Mutex<Option<PathBuf>>,
    suppress_restore: bool,
}

impl StartupWorkspace {
    /// Stash the parsed startup workspace dir (None when argv had none) and
    /// whether this launch was a hand-off (`LaunchArgs::is_handoff()`).
    pub fn new(dir: Option<PathBuf>, suppress_restore: bool) -> Self {
        Self {
            dir: Mutex::new(dir),
            suppress_restore,
        }
    }

    /// Claim the pending dir, leaving `None` so it is adopted exactly once.
    pub fn take(&self) -> Option<PathBuf> {
        self.dir.lock().unwrap().take()
    }

    /// Whether the ordinary last-workspace restore must be skipped. Stable
    /// across (and after) `take` — see the struct doc comment.
    pub fn suppress_restore(&self) -> bool {
        self.suppress_restore
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn empty_args_parse_to_nothing() {
        let got = parse_launch_args(&[]);
        assert_eq!(got.workspace, None);
        assert!(got.files.is_empty());
    }

    #[test]
    fn workspace_flag_captures_the_next_arg() {
        let got = parse_launch_args(&s(&["--workspace", "/some/dir"]));
        assert_eq!(got.workspace, Some(PathBuf::from("/some/dir")));
        assert!(got.files.is_empty());
    }

    #[test]
    fn trailing_workspace_flag_without_value_is_ignored() {
        let got = parse_launch_args(&s(&["--workspace"]));
        assert_eq!(got.workspace, None);
    }

    #[test]
    fn last_workspace_flag_wins() {
        let got = parse_launch_args(&s(&["--workspace", "/first", "--workspace", "/second"]));
        assert_eq!(got.workspace, Some(PathBuf::from("/second")));
    }

    #[test]
    fn existing_positional_files_are_collected_in_order() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "").unwrap();
        fs::write(&b, "").unwrap();
        let got = parse_launch_args(&s(&[a.to_str().unwrap(), b.to_str().unwrap()]));
        assert_eq!(got.files, vec![a, b]);
        assert_eq!(got.workspace, None);
    }

    #[test]
    fn nonexistent_and_directory_positionals_are_dropped() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.md");
        fs::write(&real, "").unwrap();
        let ghost = dir.path().join("ghost.md");
        let got = parse_launch_args(&s(&[
            ghost.to_str().unwrap(),
            dir.path().to_str().unwrap(), // a directory is not a file open
            real.to_str().unwrap(),
        ]));
        assert_eq!(got.files, vec![real]);
    }

    #[test]
    fn launcher_junk_flags_are_dropped_by_the_existing_file_filter() {
        // e.g. macOS's legacy process-serial-number arg: not a file, so it
        // falls out without a dedicated flag grammar.
        let got = parse_launch_args(&s(&["-psn_0_12345"]));
        assert!(got.files.is_empty());
        assert_eq!(got.workspace, None);
    }

    #[test]
    fn workspace_flag_and_files_combine() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("note.md");
        fs::write(&f, "").unwrap();
        let got = parse_launch_args(&s(&["--workspace", "/ws", f.to_str().unwrap()]));
        assert_eq!(got.workspace, Some(PathBuf::from("/ws")));
        assert_eq!(got.files, vec![f]);
    }

    #[test]
    fn workspace_value_that_is_an_existing_file_is_not_double_counted() {
        // The arg after --workspace is consumed as the flag's value, never
        // re-considered as a positional file.
        let dir = tempdir().unwrap();
        let f = dir.path().join("dirlike.md");
        fs::write(&f, "").unwrap();
        let got = parse_launch_args(&s(&["--workspace", f.to_str().unwrap()]));
        assert_eq!(got.workspace, Some(f));
        assert!(got.files.is_empty());
    }

    #[test]
    fn is_handoff_true_for_workspace_or_files() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("note.md");
        fs::write(&f, "").unwrap();
        assert!(parse_launch_args(&s(&["--workspace", "/ws"])).is_handoff());
        assert!(parse_launch_args(&s(&[f.to_str().unwrap()])).is_handoff());
    }

    #[test]
    fn is_handoff_false_for_a_cold_launch() {
        // Empty argv — and argv that parses down to nothing (launcher junk) —
        // is a cold launch: the persisted workspace/geometry restores run.
        assert!(!parse_launch_args(&[]).is_handoff());
        assert!(!parse_launch_args(&s(&["-psn_0_12345"])).is_handoff());
    }

    #[test]
    fn startup_workspace_takes_exactly_once() {
        let sw = StartupWorkspace::new(Some(PathBuf::from("/ws")), true);
        assert_eq!(sw.take(), Some(PathBuf::from("/ws")));
        assert_eq!(sw.take(), None, "second claim must see nothing");
    }

    #[test]
    fn startup_workspace_default_is_empty() {
        assert_eq!(StartupWorkspace::default().take(), None);
        assert!(!StartupWorkspace::default().suppress_restore());
        assert_eq!(StartupWorkspace::new(None, false).take(), None);
    }

    #[test]
    fn suppress_restore_is_not_consumed_by_take() {
        // A files-only hand-off has no dir to take, yet must still suppress
        // the restore; and taking the dir must not clear the flag either.
        let files_only = StartupWorkspace::new(None, true);
        assert_eq!(files_only.take(), None);
        assert!(files_only.suppress_restore());

        let with_dir = StartupWorkspace::new(Some(PathBuf::from("/ws")), true);
        assert!(with_dir.suppress_restore());
        with_dir.take();
        assert!(with_dir.suppress_restore(), "stable across take()");
    }
}
