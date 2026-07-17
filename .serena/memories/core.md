# Core

`markdon` — a Tauri v2 desktop **markdown editor** with Typora/Obsidian-style WYSIWYG editing. Implemented and merged to `main` (2026-07-18). Markdown text is the single source of truth.

## Source map
- `src/lib/document.ts` — Svelte store `{ path, content, dirty, loadId }` + transitions `openDoc`/`newDoc`/`edit`/`markSaved`. `loadId` bumps ONLY on open/new.
- `src/lib/files.ts` — `open`/`save`/`saveAs`: native dialogs + `invoke` of Rust commands; reports failures via `errors.ts`.
- `src/lib/errors.ts` — `errorMessage` store + `reportError`/`clearError`.
- `src/App.svelte` — owns store; `listen`s menu/close events; `{#key $document.loadId}` re-mounts the editor on open/new; unified unsaved-changes guard (New/Open/close) via a `pendingAction` modal.
- `src/Editor.svelte` — Milkdown Crepe wrapper; `src/StatusBar.svelte` — filename/dirty/word-count; `src/Banner.svelte` — error banner.
- `src-tauri/src/commands.rs` — `read_file`/`write_file` (ONLY disk path) + `reject_unsafe_path` guard.
- `src-tauri/src/menu.rs` — native menu; `src-tauri/src/lib.rs` — builder: dialog plugin, invoke handler, `.setup` (menu + `on_menu_event` emit + window `CloseRequested`).

Domain memories: stack `mem:tech_stack`; commands `mem:suggested_commands`; conventions/invariants `mem:conventions`; done-checks `mem:task_completion`.

Platform: macOS (Darwin), zsh.
