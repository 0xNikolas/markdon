# markdon — Markdown Editor Design

**Date:** 2026-07-17
**Status:** Approved for planning

## Overview

`markdon` is a desktop markdown editor with a Typora-style WYSIWYG (inline
live-preview) editing experience. Markdown text is the single source of truth:
it lives in a Svelte store, flows into the editor for editing, and flows back to
disk unchanged.

### Stack

- **Tauri v2** — desktop shell, Rust core.
- **Svelte 5 + TypeScript** — UI, built with Vite.
- **Milkdown (Crepe)** — WYSIWYG markdown editor (ProseMirror + Remark). Remark
  is the document model, so what is edited maps directly to clean markdown.

### First-version scope

- Single-file open / save / save-as via native dialogs.
- WYSIWYG inline editing.
- Native menu with accelerators, unsaved-changes guard, word count.

### Out of scope (deliberate, easy follow-ons)

Folder/workspace sidebar, multi-tab, themes/settings, export (PDF/HTML),
auto-save, recent-files list, E2E tests.

## Architecture

Thin Rust core + Svelte web UI. Rust owns OS-facing concerns (native menus, file
dialogs, disk I/O); the web UI owns editing and rendering.

```
┌─────────────────────────────────────────────┐
│  Rust core (src-tauri)                        │
│  • native menu (New/Open/Save/Save As)        │
│  • file dialogs (open/save pickers)           │
│  • read_file / write_file commands            │
└───────────────▲──────────────┬───────────────┘
        invoke  │              │  menu events
┌───────────────┴──────────────▼───────────────┐
│  Svelte UI                                     │
│  App.svelte  ── owns document store            │
│    ├─ Editor.svelte  (Milkdown Crepe wrapper)  │
│    └─ StatusBar.svelte (filename, dirty, words)│
└───────────────────────────────────────────────┘
```

## Components & responsibilities

### Rust (`src-tauri/src/`)

- **`lib.rs`** — Tauri builder: registers commands, builds the menu, routes menu
  events to the frontend via an emitted event. Intercepts the window
  `close-requested` event for the unsaved-changes guard.
- **`main.rs`** — thin entry point calling into `lib.rs`.
- **`menu.rs`** — constructs the native menu with accelerators
  (⌘N / ⌘O / ⌘S / ⌘⇧S).
- **`commands.rs`** — `read_file(path) -> Result<String, String>` and
  `write_file(path, contents) -> Result<(), String>`. All disk access is
  confined here; no broad fs-plugin scope is exposed to JS.

### Frontend (`src/`)

- **`lib/document.ts`** — the `document` store:
  `{ path: string | null, content: string, dirty: boolean, loadId: number }`,
  plus typed transitions (`openDoc`, `markSaved`, `edit`, `newDoc`). `loadId` is
  a monotonic counter bumped by `openDoc` / `newDoc` to force editor re-mounts
  (see re-mount detail). Pure logic, unit-tested.
- **`lib/files.ts`** — orchestration wrappers: `open()`, `save()`, `saveAs()` —
  call the dialog plugin for pickers and `invoke` the Rust commands.
- **`Editor.svelte`** — wraps Crepe; renders current content, emits changes back
  to the store (sets `dirty`).
- **`StatusBar.svelte`** — filename (or "Untitled"), a dirty dot, word count.
- **`App.svelte`** — subscribes to menu events, owns the store, wires
  open/save/new, and the close-with-unsaved-changes guard.

## Data flow

- **Open:** menu / ⌘O → `files.open()` → dialog returns a path →
  `invoke("read_file")` → `openDoc({path, content})` → Editor re-mounts (see
  re-mount detail) with new content.
- **Edit:** Crepe change → `edit(content)` → `dirty = true`.
- **Save:** ⌘S → if `path` is null, fall through to Save As; else
  `invoke("write_file")` → `markSaved()`.
- **Save As:** `dialog.save()` → path → write → `markSaved()`.
- **New:** if `dirty`, confirm discard → `newDoc()` (empty, `path = null`).

### Editor re-mount detail

ProseMirror/Crepe does not cleanly swap its whole document from outside. On open
or New, the Crepe instance is destroyed and recreated using Svelte's
`{#key loadId}` block, where `loadId` is a monotonic counter bumped by every
`openDoc` / `newDoc` transition. Keying on `loadId` (rather than `path`)
guarantees a rebuild even when two loads share the same path — e.g. re-opening
the same file, or two `newDoc` calls that both have `path = null`. Typing edits
stay in-place and fast; only load/new triggers a rebuild.

## Error handling

- Rust commands return `Result<_, String>`; the frontend surfaces failures in a
  small non-blocking error banner.
- **No JS `alert` / `confirm` / `prompt`** — they block the webview. All
  confirmations use a custom in-app modal.
- **Read fails** (missing file, permissions): show the message, keep the current
  document untouched.
- **Write fails:** show the message, keep `dirty = true` so the user can retry.
- **Unsaved-changes guard:** intercept the window `close-requested` event in
  Rust; if the frontend reports `dirty`, show the in-app confirm modal before
  closing.

## Testing

- **Rust:** unit tests for `read_file` / `write_file` against a `tempdir`
  (round-trip, missing-file error, overwrite).
- **Frontend:** Vitest over `document.ts` — dirty transitions, open→edit→save
  lifecycle, Save-As-when-path-null — with `invoke` / dialog mocked. Written
  test-first, since this store holds the app's core invariants.
- **`Editor.svelte`** is a thin wrapper — covered by a light mount test plus
  manual verification; full WYSIWYG behavior is Milkdown's own tested surface.
- E2E (WebDriver) is out of scope for the first version.

## Project structure

```
markdon/
├─ src/
│  ├─ lib/{document.ts, files.ts}
│  ├─ Editor.svelte, StatusBar.svelte, App.svelte
│  ├─ main.ts, app.css
├─ src-tauri/
│  ├─ src/{lib.rs, main.rs, menu.rs, commands.rs}
│  ├─ Cargo.toml, tauri.conf.json, build.rs
├─ index.html, package.json, vite.config.ts, tsconfig.json
├─ svelte.config.js
```
