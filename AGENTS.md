# Markdon — contributor & agent guide

Markdon is a native **macOS markdown editor**: a **Tauri 2** (Rust) backend in
`src-tauri/src/*.rs` wrapping a **Svelte 5 (runes)** frontend in `src/`. Editing
is **Milkdown Crepe** WYSIWYG (`src/Editor.svelte`) with an optional
**CodeMirror 6** source pane (`src/SourcePane.svelte` / `SplitView.svelte`).
The package manager and task runner is **bun** — never npm/yarn/pnpm.

> Sprint planning docs live in `tasks/`, which is **gitignored** — you will not
> find sprint rationale in the repo, only in the code and this file.

`CLAUDE.md` is a symlink to this file; there is one canonical doc, agent-agnostic.

## Commands

Frontend / tests (from the repo root):

- `bun install --frozen-lockfile` — install deps.
- `bun run test` — vitest (`vitest run`), node-env unit tests for `src/lib/*.ts`.
- `bun run check` — `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json`.
- `bun run e2e` — Playwright (CI uses `bunx playwright test`); WebKit, runs against the **real `vite build` bundle** (see e2e below).
- `bun run dev` / `bun run build` / `bun run preview` — vite.
- `bun run tauri <cmd>` — e.g. `bun run tauri dev`, `bun run tauri build`.
- `bun run vendor:icons` — regenerate vendored icons (`scripts/vendor-icons.mjs`).
- `bun run install:cli` — symlink the `md` CLI into `~/.local/bin` (see below).

Rust (from `src-tauri/`):

- `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`.

CI (`.github/workflows/ci.yml`) mirrors these as separate jobs: `frontend`
(check + test, ubuntu), `e2e` (Playwright/WebKit, macos-14), `rust`
(fmt/clippy/test, macos-14), and `embed-assert` (see the build gotcha below).

**The four gates before you're done:** `bun run check`, `bun run test`,
`bun run e2e`, and the three `cargo` commands.

## Architecture convention

Keep `.svelte` components **thin**. Real logic lives in `src/lib/*.ts` with a
**colocated `*.test.ts`** run under node-env vitest. Testability comes from
**injected env interfaces** (e.g. `settings.ts` `SettingsEnv`, `theme.ts`
`ThemeEnv`) so DOM / localStorage / IPC touchpoints are stubbable without a
browser.

The Rust command surface is registered in `src-tauri/src/lib.rs`
(`invoke_handler`). The **trust boundary** is `src-tauri/src/allowlist.rs`
(`AllowedPaths`): the webview can only read/write/watch paths Rust explicitly
granted — dialog picks and OS open events (`allow`, exact-string), or workspace
roots (`allow_root`, canonicalized, containment-checked). `ensure` canonicalizes
before comparing, so `..` traversal, symlink escape, nonexistent-path probing,
and shared-prefix siblings (`/ws-evil` vs root `/ws`) all fail closed.
Rust-owned config paths (`settings.json`, `workspace.json`) are **never named by
the webview** — that keeps the allowlist invariant intact.

Distinct from that: the **asset-protocol scope** (`allow_asset_dir` in `lib.rs`)
is **display-only** — it appears solely in the CSP's `img-src` so `asset://`
image refs render. Read/write IPC still enforces exact grants via
`AllowedPaths::ensure`; the two channels are separate.

## State-file map

State lives in two OS dirs; every file has a single owner.

**localStorage boot caches** (per bundle-id, stamped synchronously **pre-mount**
in `src/main.ts` so theme/typography apply before first paint). These are caches
only — the Rust file is source of truth:

- `markdon.settings.v1` (`settings.ts` `SETTINGS_KEY`) — the full Settings JSON.
- `markdon.themePref` (`theme.ts` `STORAGE_KEY`; also the legacy seed key in `settings.ts`).
- `markdon.split` (`ui.ts` `SPLIT_KEY`) — split-preview flag, read once per window at module load (deliberately NOT synced through settings, so windows don't couple their split state).

Single-writer rules: **`settings.ts` owns theme** — it is the sole writer of
`theme.ts`'s `themePref` after boot. `theme.ts` owns `resolvedTheme`
(pref × system-dark). The settings subscriber guards against feedback loops
(an `echo` guard pre-stamps the normalized serialization; a `stale-overwrite`
guard applies a remote value only while the store still equals the boot
snapshot); `initSettings`/`initTheme` are re-entry-safe. Reconcile happens after
mount via `load_prefs` and again on window **focus**.

In-memory-only UI stores (`ui.ts`): `emptyState` (no-document page) and
`imageView` (see Image view) — not persisted.

**Rust-owned files** in `app_config_dir()`:

- `settings.json` (`prefs.rs`) — per-app editor prefs shared by all instances/windows. `validate_prefs` only caps size (64 KB) and requires a top-level JSON object; the frontend's tolerant `parseSettings` is the schema authority. Writes are atomic (`history::atomic_write`); concurrent saves are whole-file last-writer-wins, never torn; the loser converges on next focus.
- `workspace.json` (`workspace.rs`, `WorkspaceState { version: 2, current, roots }`) — `current` is the launch-restore pointer (cleared on close), `roots` is the Open Recent MRU (newest-first, deduped, capped at 10). A legacy `{"root": …}` file migrates in-memory on read; the write side always emits v2.

**Rust-owned per-workspace state** in `app_data_dir()/workspace-state/<sha256hex(canonical root)>/`
(hash via `history.rs` `bucket_key`), two tenants:

- `ui.json` (**v2**: `{ version: 2, tabs, preview, active }`, `workspace.rs`) — the whole Open Files strip so reopening a workspace rebuilds it: `tabs` are pinned rows in strip order, `preview` the volatile italic row (never in `tabs`), `active` the file in the editor. A v1 `{ version: 1, lastFile }` file migrates to `active = lastFile` with no tabs. **Load is the trust boundary**: every stored path must canonicalize to an existing regular file strictly inside the root, else it's silently dropped (a tampered/vanished entry buys a dropped row, never an escape). Commands `save_workspace_ui` / `load_workspace_ui` require a granted root (`ensure_root`).
- `history/<sha256hex(canonical abs file path)>/` — content-addressed save snapshots (`history.rs`). Standalone files opened outside any workspace bucket at the legacy `app_data_dir()/history/<hash>/` instead; a workspace file's legacy bucket migrates lazily on first touch.

**Logging** (`logging.ts` + `lib.rs`): the frontend forwards `console.warn/error`
and uncaught errors/rejections into the Tauri log plugin (`logging.ts` is the
only importer of `@tauri-apps/plugin-log`). The primary instance writes
`markdon.log`; a **handed-off child** writes a per-pid `markdon-<pid>.log`
(`lib.rs` `log_file_name`), so `reveal_log_file` reveals the right file.

## The keymap — add a shortcut in ONE place

`src/lib/keymap.ts` is the **single source of truth** (`KEYMAP` array) for all
three shortcut surfaces that used to hand-maintain their own copies:

1. the **window keydown** matcher — App's driver runs `matchKeydown` (first
   match wins, in array order), then applies the entry's `keydownGuard` /
   `preventDefault` mode;
2. **menu-event routing** — App subscribes `menu:<id>` for every entry with
   `hasMenuItem` set;
3. the **Settings > Shortcuts** list — `settingsList()` returns the
   `showInSettings` rows sorted by `settingsOrder`.

**To add a shortcut: add one `KEYMAP` entry, plus a `run` action closure in
`App.svelte` keyed by the same `id`.** The table holds only pure, testable DATA
(id, display keys, the pure `match` predicate, guard/preventDefault flags); the
action closures live in App because they close over its stores. Array order is
load-bearing for matching (e.g. `find_replace` must precede `find`); Settings
display order is `settingsOrder`, independent of array position. The `keys[]`
display strings **mirror `src-tauri/src/menu.rs` accelerators** — keep the two in
sync (they are two representations of one binding; don't derive one from the
other).

## Buffer cache invariants

`src/lib/bufferCache.ts` is what makes cross-file switching instant.

- **The live doc is never also cached** — only a doc switched *away* from is stashed (keyed by path, with content/baselines/cursor/scroll).
- Membership: cache keys ⊆ openList (**pinned paths only**); a clean preview is simply dropped on switch-away. The `files.ts` `stashActive` choke-point defensively pins any dirty pathed doc before stashing.
- `MAX_CLEAN_CACHED = 20` LRU cap over **clean** entries only — dirty entries (unsaved data) are never cap-evicted.
- `take()` consumes on restore (removing the stale fork); `peek()` reads without consuming; `evict` / `evictSubtree` / `retarget` follow tab-close / delete / rename.

Two App.svelte guards decide when a discard prompt appears:

- `guarded()` wraps **destructive** actions (tab close, Read-Only toggle on a dirty path, File History revert): `flushBufferEdits()`, then prompt via the discard overlay if dirty.
- `switchGuarded()` wraps **switch** actions (opening another file, New): a dirty *pathed* doc stashes into the cache and the switch runs immediately (no prompt); only a dirty *untitled* scratch (no cache key) still prompts.

Strip row order is **newest-first** (`openList.ts` `stripOrder`, preview-first):
a new open prepends at index 0.

## e2e stub architecture

Playwright boots the **real production bundle** — `vite build` output served
directly — in plain WebKit. `e2e/support/tauriInternals.js` is a dependency-free
classic script (installed via `page.addInitScript`) that installs
`window.__TAURI_INTERNALS__`, stubbing the IPC boundary so the unmodified
frontend runs. Same philosophy as the vitest node mocks in
`src/lib/test-support/` (`tauriMocks.ts` + `workspaceFixtures.ts`) — don't confuse
the two.

**Parity discipline:** any command the stub doesn't know **rejects**, so a new
startup IPC call fails the smoke suite loudly until it gets a default.

Seed / hook globals (readable and seedable from specs):

- `__TAURI_IPC_CALLS__` — log of every `{ cmd, args }` invoked (the assertion surface for fire-and-forget commands).
- `__TAURI_FS__` — path → contents, backing `read_file` and the fileops mutations.
- `__TAURI_DIRS__` — extra (possibly empty) directory paths for the derived tree.
- `__TAURI_WORKSPACE_ROOT__` — when set, `restore_workspace` / `list_workspace` derive a live tree from the FS + DIRS maps (`buildWorkspace`).
- `__TAURI_RECENT__` — roots served by `list_recent_workspaces`.
- `__TAURI_WORKSPACE_UI__` — root → `{tabs,preview,active}` (or a bare string as a v1 `lastFile`) for `save/load_workspace_ui`, mirroring the Rust containment + existence validation.
- `__TAURI_IPC_ERRORS__` — cmd → message; invoke rejects with the **raw string** (like a Rust error), checked **before** overrides.
- `__TAURI_IPC_OVERRIDES__` — cmd → static resolved value, wins over the built-in table.
- `__tauriEmit(event, payload)` — fire registered listeners (drives `menu:*` events).

fileops mutations (create / create_folder / rename / move / copy / duplicate /
delete) mirror `fileops.rs` against the in-memory maps; collisions reject with the
exact Rust `NO_CLOBBER` string.

Helpers in `e2e/support/workspaceFixture.ts`: `STUB` path, `ROOT = /ws`,
`seedWorkspace(page, opts)` (fixture tree `notes.md`/`ideas.md`/`guide.md`,
`readme.txt` non-md, `huge.md` one line over the 100 000 long-line limit,
`sub/nested.md`; `opts.overrides`/`errors`/`extraFiles`), `gotoApp(page)`,
locators (`workspaceTree`, `openFilesStrip`, `emptyPage`, `treeRow`, `stripRows`,
`editor`, `discardDialog`), `calls`/`emitTauri`, and state builders `pinFile` /
`switchTo` / `closeStripRow` / `makeDirty`.

## Build gotcha: stale embedded assets

Assets are embedded into the release binary by `generate_context!()` at
compile time (release / custom-protocol builds only). cargo does not otherwise
track `dist/`, so historically a **frontend-only change could ship a stale
binary** (it once bit the theme toggle). This is now fixed structurally:
`src-tauri/build.rs` emits `cargo:rerun-if-changed=../dist`, folding the frontend
into the crate's fingerprint so a changed `dist/` forces a recompile + re-embed;
and the CI `embed-assert` job builds the release binary and asserts the embedded
asset fingerprint matches `dist/assets/index-<hash>.js`.

**Practical upshot:** after a frontend-only change the binary re-embeds
automatically — no manual step. (The old workaround, `touch src-tauri/src/main.rs`
to force a re-embed, is no longer needed.)

## The `md` CLI

`md <path>` opens a file or folder in a **new app instance** (a separate
process): a file is passed as a positional arg, a folder as `--workspace <dir>`,
parsed by `src-tauri/src/launch.rs`. Install with `bun run install:cli` (symlinks
`scripts/md` into `~/.local/bin`). See `README.md` for multi-path rules and
binary discovery.

## Image view

Clicking an image row in the workspace tree opens it in a **transient,
non-editable overlay** (`imageView` store in `ui.ts`) that sits over the editor
**without touching `$doc`** — any unsaved buffer survives untouched, and opening
any document (the doc-load chokepoint) dismisses the view. It is mutually
exclusive with `emptyState`.

## Adding a feature — checklist

1. Put logic in `src/lib/*.ts` with a colocated `*.test.ts`; keep the `.svelte` component thin. Inject env interfaces rather than reaching for globals directly.
2. New IPC? Add the Rust command in the relevant `src-tauri/src/*.rs`, register it in `lib.rs`, and route every user path through `AllowedPaths::ensure` (or `ensure_root` / `ensure_container`). Add a default to `e2e/support/tauriInternals.js` or the smoke suite fails.
3. New shortcut? One `KEYMAP` entry + one `App.svelte` action closure by `id`, and mirror the accelerator in `menu.rs`.
4. Persisted state? Decide the owner up front (localStorage cache vs Rust file) and respect the single-writer rules above.
5. Run the four gates: `bun run check`, `bun run test`, `bun run e2e`, and `cargo fmt --check` / `clippy` / `test`.
