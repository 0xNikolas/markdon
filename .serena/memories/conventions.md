# Conventions

## Load-bearing invariants (breaking these breaks the app)
- **IPC contract:** frontend `invoke` arg keys must exactly match Rust command params — `read_file(path)`, `write_file(path, contents)`. Never rename `path`/`contents`.
- **Menu three-way match:** menu item id in `menu.rs` == string emitted by `on_menu_event` in `lib.rs` (`event.id().0.as_str()`) == `listen(...)` name in `App.svelte`. Ids: `menu:new/open/save/save_as`. Also `window:close-requested`.
- **loadId discipline:** bump `loadId` only in `openDoc`/`newDoc` (forces editor re-mount via `{#key loadId}`); `edit`/`markSaved` leave it unchanged.
- **All disk access stays in `commands.rs`** (Rust). Frontend gets no broad fs scope. `reject_unsafe_path` runs BEFORE any `fs::` call in both commands.

## Security posture
- App intentionally reads/writes any user-selected path (native dialog = trust boundary); do NOT sandbox to a base dir.
- Strict CSP in `tauri.conf.json` (`script-src 'self'`, no unsafe-inline) closes the XSS→IPC path. `style-src` keeps `'unsafe-inline'` for Milkdown.
- Bundle identifier: `com.markdon.editor` (avoid `.app` suffix — macOS bundle warning).

## Style / process
- **No JS `alert`/`confirm`/`prompt`** — use the in-app Banner + modal (they block the webview).
- **Commit messages:** conventional-commit style, **never** a `Co-Authored-By: Claude` trailer (hard user rule).
- Svelte 5 runes only (`$props`/`$state`/`$derived`), not Svelte 4 `export let`.
- Editor typography overrides live in `src/editor-theme.css`, imported after the Crepe theme.
