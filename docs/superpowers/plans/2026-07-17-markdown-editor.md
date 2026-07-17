# markdon Markdown Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri v2 desktop markdown editor with a Typora-style WYSIWYG editor (Milkdown Crepe) and single-file open/save.

**Architecture:** Thin Rust core owns native menus, file dialogs, and disk I/O; a Svelte 5 + TypeScript UI owns editing and rendering. Markdown text is the single source of truth, held in a Svelte store, edited via Milkdown Crepe, and written to disk unchanged.

**Tech Stack:** Tauri v2 (Rust), Svelte 5 + TypeScript, Vite, Milkdown Crepe (`@milkdown/crepe`), `@tauri-apps/plugin-dialog`, Vitest.

## Global Constraints

- **Tauri v2** (crate `tauri = "2"`, `@tauri-apps/api` `^2`, `@tauri-apps/cli` `^2`).
- **Svelte 5** with runes (`$props`, `$state`) for components; `svelte/store` `writable` for the document store.
- **Milkdown Crepe** `@milkdown/crepe` `^7`.
- **No JS `alert` / `confirm` / `prompt`** anywhere — they block the webview. All confirmations use a custom in-app modal component.
- **All disk access lives in Rust** (`commands.rs`). JS never gets a broad fs-plugin scope; it only calls `read_file` / `write_file` and the dialog plugin.
- **Vite dev server:** port `1420`, `strictPort: true`, to match `tauri.conf.json`.
- **Rust command signatures are the contract** — frontend `invoke` argument keys must match Rust parameter names exactly (`path`, `contents`).
- **Commit messages:** conventional-commit style, **no `Co-Authored-By` trailer of any kind**.
- **Package manager & runner: bun** (not npm/npx). Use `bun install`, `bun add`, `bun add -d`, `bun run <script>`, `bunx <bin>`. Commit `bun.lockb`. The `node_modules` dir is still used and stays git-ignored. Vitest remains the test framework (its `vi.mock` / `describe`/`it`/`expect` APIs are used) — run it via `bun run test` (the npm-script `vitest run`), **never** `bun test` (that invokes Bun's own incompatible runner).
- Target platform: macOS (Darwin). Menu includes a macOS app submenu + native Edit submenu so system shortcuts (⌘C/⌘V/⌘Z) work.

---

### Task 1: Scaffold Vite + Svelte-TS + Tauri v2 project

Foundation task: produces a running (empty-window) Tauri app plus a working Vitest setup. Scaffolds into a temp dir first because the project root is non-empty (`.git`, `README.md`, `docs/`), which the interactive scaffolders refuse.

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `svelte.config.js`, `index.html`, `src/main.ts`, `src/App.svelte`, `src/app.css`, `src/vite-env.d.ts`
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`
- Create: `vitest.config.ts`
- Modify: `.gitignore` (add `node_modules`, `dist`, `src-tauri/target`)
- Note: current create-vite emits `tsconfig.json` + `tsconfig.app.json` + `tsconfig.node.json` — copy all `tsconfig*.json`.

**Interfaces:**
- Produces: a `src-tauri/src/lib.rs` exposing `pub fn run()` called by `main.rs`; a `run()` builder that later tasks extend with `.plugin(...)`, `.invoke_handler(...)`, `.setup(...)`.

- [ ] **Step 1: Scaffold a Vite Svelte-TS project in a temp dir and copy it in**

Run (adjust the scratchpad path if different):

```bash
TMP="/private/tmp/claude-501/scaffold-markdon"
rm -rf "$TMP" && mkdir -p "$TMP"
# bun create scaffolds a Vite Svelte-TS project (non-interactive)
cd "$TMP" && bun create vite app --template svelte-ts
# Copy config + source into the project root, preserving .git/README/docs.
# Copy all tsconfig*.json (create-vite splits tsconfig.app.json / tsconfig.node.json).
cd "$TMP/app"
cp -R index.html package.json svelte.config.js tsconfig*.json vite.config.ts src /Users/nicu/Projects/markdon/
```

Expected: project root now has `src/`, `index.html`, `package.json`, `vite.config.ts`, etc. `.git`, `README.md`, `docs/` untouched.

- [ ] **Step 2: Pin the Vite dev server to port 1420**

Overwrite `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
})
```

- [ ] **Step 3: Install JS dependencies (frontend + Tauri CLI + editor + test runner)**

Run:

```bash
cd /Users/nicu/Projects/markdon
bun install
bun add @tauri-apps/api@^2 @tauri-apps/plugin-dialog@^2 @milkdown/crepe@^7
bun add -d @tauri-apps/cli@^2 vitest@^2
```

Expected: installs succeed; `bun.lockb` is created; `@tauri-apps/cli` available via `bunx tauri`.

- [ ] **Step 4: Initialize the Tauri Rust project non-interactively**

Run:

```bash
cd /Users/nicu/Projects/markdon
bunx tauri init --ci \
  --app-name markdon \
  --window-title markdon \
  --frontend-dist ../dist \
  --dev-url http://localhost:1420 \
  --before-dev-command "bun run dev" \
  --before-build-command "bun run build"
```

Expected: creates `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`, `build.rs`, `capabilities/default.json`, and icons.

Then set a real bundle identifier (the generated placeholder `com.tauri.dev` is rejected by `tauri build`). In `src-tauri/tauri.conf.json`, set:

```json
"identifier": "com.markdon.app"
```

- [ ] **Step 5: Add the `tauri` script**

Edit `package.json` `"scripts"` to include:

```json
"tauri": "tauri"
```

- [ ] **Step 6: Configure Vitest (node environment — pure logic only)**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true, // vitest@2 exits 1 with no test files otherwise
  },
})
```

Add to `package.json` `"scripts"`: `"test": "vitest run"`.

- [ ] **Step 7: Update `.gitignore`**

Ensure these lines exist:

```
node_modules
dist
src-tauri/target
```

- [ ] **Step 8: Verify the app compiles**

Run the non-blocking build check (do **not** run `bun run tauri dev` in an automated/non-interactive session — it opens a blocking GUI window that hangs):

```bash
cd /Users/nicu/Projects/markdon
bunx tauri build --no-bundle
```

Expected: Vite build + Rust release compile both succeed. (Interactively, `bun run tauri dev` opens a native window showing the default page.)

- [ ] **Step 9: Verify Vitest runs**

Run: `bun run test`
Expected: "No test files found" and exit 0 (`passWithNoTests`) — the runner is wired; tests come in later tasks.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri v2 + Svelte-TS + Vitest project"
```

---

### Task 2: Rust file I/O commands

TDD in Rust. Adds `read_file` / `write_file` commands and registers them. These are the only paths to disk.

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (declare `mod commands;`, register handler)
- Modify: `src-tauri/Cargo.toml` (add `tempfile` dev-dependency)

**Interfaces:**
- Produces:
  - `#[tauri::command] pub fn read_file(path: String) -> Result<String, String>`
  - `#[tauri::command] pub fn write_file(path: String, contents: String) -> Result<(), String>`
  - Frontend contract: `invoke<string>('read_file', { path })`, `invoke('write_file', { path, contents })`.

- [ ] **Step 1: Add `tempfile` dev-dependency**

In `src-tauri/Cargo.toml`, under `[dev-dependencies]` (create the section if absent):

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the failing tests + command stubs**

Create `src-tauri/src/commands.rs`:

```rust
use std::fs;

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    todo!()
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap().to_string();

        write_file(p.clone(), "# Hello".into()).unwrap();
        let got = read_file(p).unwrap();
        assert_eq!(got, "# Hello");
    }

    #[test]
    fn read_missing_file_returns_err() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.md");
        let res = read_file(missing.to_str().unwrap().to_string());
        assert!(res.is_err());
    }

    #[test]
    fn write_overwrites_existing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let p = path.to_str().unwrap().to_string();

        write_file(p.clone(), "first".into()).unwrap();
        write_file(p.clone(), "second".into()).unwrap();
        assert_eq!(read_file(p).unwrap(), "second");
    }
}
```

- [ ] **Step 3: Wire the module so tests compile, then run to verify they fail**

In `src-tauri/src/lib.rs`, add near the top: `mod commands;`

Run: `cd src-tauri && cargo test`
Expected: FAIL — the three tests panic on `not yet implemented` (`todo!()`).

- [ ] **Step 4: Implement the commands**

Replace the two function bodies in `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — 3 passed.

- [ ] **Step 6: Register the commands in the builder**

In `src-tauri/src/lib.rs`, add the invoke handler to the builder chain inside `run()`:

```rust
.invoke_handler(tauri::generate_handler![
    commands::read_file,
    commands::write_file
])
```

- [ ] **Step 7: Verify it still compiles**

Run: `cd src-tauri && cargo build`
Expected: builds cleanly.

- [ ] **Step 8: Commit**

```bash
git add src-tauri
git commit -m "feat: add read_file and write_file Rust commands"
```

---

### Task 3: Document store

TDD. The store holds the app's core invariants. Pure logic, node-testable.

**Files:**
- Create: `src/lib/document.ts`
- Test: `src/lib/document.test.ts`

**Interfaces:**
- Produces:
  - `interface DocState { path: string | null; content: string; dirty: boolean; loadId: number }`
  - `const document: Writable<DocState>` (initial `{ path: null, content: '', dirty: false, loadId: 0 }`)
  - `function openDoc(path: string, content: string): void` — sets path+content, `dirty=false`, **bumps** `loadId`.
  - `function newDoc(): void` — resets to empty, `path=null`, `dirty=false`, **bumps** `loadId`.
  - `function edit(content: string): void` — sets content, `dirty=true`, `loadId` **unchanged**.
  - `function markSaved(path: string): void` — sets path, `dirty=false`, `loadId` **unchanged**.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/document.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { document, openDoc, newDoc, edit, markSaved } from './document'

describe('document store', () => {
  beforeEach(() => newDoc()) // reset (also bumps loadId, fine for isolation)

  it('openDoc sets path and content, clears dirty, bumps loadId', () => {
    const before = get(document).loadId
    openDoc('/tmp/a.md', '# A')
    const s = get(document)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# A')
    expect(s.dirty).toBe(false)
    expect(s.loadId).toBe(before + 1)
  })

  it('edit updates content, sets dirty, leaves loadId unchanged', () => {
    openDoc('/tmp/a.md', '# A')
    const loadId = get(document).loadId
    edit('# A edited')
    const s = get(document)
    expect(s.content).toBe('# A edited')
    expect(s.dirty).toBe(true)
    expect(s.loadId).toBe(loadId)
  })

  it('markSaved clears dirty and sets path without bumping loadId', () => {
    newDoc()
    edit('draft')
    const loadId = get(document).loadId
    markSaved('/tmp/new.md')
    const s = get(document)
    expect(s.path).toBe('/tmp/new.md')
    expect(s.dirty).toBe(false)
    expect(s.loadId).toBe(loadId)
  })

  it('newDoc resets to an empty untitled document', () => {
    openDoc('/tmp/a.md', '# A')
    newDoc()
    const s = get(document)
    expect(s.path).toBeNull()
    expect(s.content).toBe('')
    expect(s.dirty).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — cannot resolve `./document` (module not created yet).

- [ ] **Step 3: Implement the store**

Create `src/lib/document.ts`:

```ts
import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  dirty: boolean
  loadId: number
}

const initial: DocState = { path: null, content: '', dirty: false, loadId: 0 }

export const document: Writable<DocState> = writable(initial)

export function openDoc(path: string, content: string): void {
  document.update((s) => ({ path, content, dirty: false, loadId: s.loadId + 1 }))
}

export function newDoc(): void {
  document.update((s) => ({ path: null, content: '', dirty: false, loadId: s.loadId + 1 }))
}

export function edit(content: string): void {
  document.update((s) => ({ ...s, content, dirty: true }))
}

export function markSaved(path: string): void {
  document.update((s) => ({ ...s, path, dirty: false }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/document.ts src/lib/document.test.ts
git commit -m "feat: add document store with tested state transitions"
```

---

### Task 4: File orchestration (open / save / saveAs)

TDD with mocked Tauri modules. Ties dialogs + Rust commands to the store.

**Files:**
- Create: `src/lib/files.ts`
- Test: `src/lib/files.test.ts`

**Interfaces:**
- Consumes: `document`, `openDoc`, `markSaved` from `./document`; `invoke` from `@tauri-apps/api/core`; `open`, `save` from `@tauri-apps/plugin-dialog`.
- Produces:
  - `async function open(): Promise<void>`
  - `async function save(): Promise<void>`
  - `async function saveAs(): Promise<void>`

- [ ] **Step 1: Write the failing tests (with mocked Tauri deps)**

Create `src/lib/files.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const invoke = vi.fn()
const openDialog = vi.fn()
const saveDialog = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: (...a: unknown[]) => saveDialog(...a),
}))

import { document, newDoc, edit } from './document'
import { open, save, saveAs } from './files'

beforeEach(() => {
  invoke.mockReset()
  openDialog.mockReset()
  saveDialog.mockReset()
  newDoc()
})

describe('open', () => {
  it('loads the picked file into the store', async () => {
    openDialog.mockResolvedValue('/tmp/a.md')
    invoke.mockResolvedValue('# Loaded')
    await open()
    expect(invoke).toHaveBeenCalledWith('read_file', { path: '/tmp/a.md' })
    const s = get(document)
    expect(s.path).toBe('/tmp/a.md')
    expect(s.content).toBe('# Loaded')
    expect(s.dirty).toBe(false)
  })

  it('does nothing when the dialog is cancelled', async () => {
    openDialog.mockResolvedValue(null)
    await open()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('save', () => {
  it('writes to the existing path and clears dirty', async () => {
    // arrange a document already backed by a path
    document.set({ path: '/tmp/a.md', content: 'body', dirty: true, loadId: 1 })
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/a.md', contents: 'body' })
    expect(get(document).dirty).toBe(false)
  })

  it('falls back to Save As when there is no path', async () => {
    newDoc()
    edit('draft')
    saveDialog.mockResolvedValue('/tmp/new.md')
    invoke.mockResolvedValue(undefined)
    await save()
    expect(invoke).toHaveBeenCalledWith('write_file', { path: '/tmp/new.md', contents: 'draft' })
    expect(get(document).path).toBe('/tmp/new.md')
    expect(get(document).dirty).toBe(false)
  })
})

describe('saveAs', () => {
  it('does nothing when the save dialog is cancelled', async () => {
    newDoc()
    edit('draft')
    saveDialog.mockResolvedValue(null)
    await saveAs()
    expect(invoke).not.toHaveBeenCalled()
    expect(get(document).dirty).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — cannot resolve `./files`.

- [ ] **Step 3: Implement the orchestration**

Create `src/lib/files.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { get } from 'svelte/store'
import { document, openDoc, markSaved } from './document'

const MD_FILTER = { name: 'Markdown', extensions: ['md', 'markdown'] }

export async function open(): Promise<void> {
  const selected = await openDialog({ filters: [MD_FILTER], multiple: false, directory: false })
  if (typeof selected !== 'string') return // cancelled
  const content = await invoke<string>('read_file', { path: selected })
  openDoc(selected, content)
}

export async function save(): Promise<void> {
  const state = get(document)
  if (state.path === null) return saveAs()
  await invoke('write_file', { path: state.path, contents: state.content })
  markSaved(state.path)
}

export async function saveAs(): Promise<void> {
  const state = get(document)
  const selected = await saveDialog({
    filters: [MD_FILTER],
    defaultPath: state.path ?? 'untitled.md',
  })
  if (selected === null) return // cancelled
  await invoke('write_file', { path: selected, contents: state.content })
  markSaved(selected)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS — all `files` + `document` tests pass.

- [ ] **Step 5: Register the dialog plugin (Rust + capabilities)**

In `src-tauri/Cargo.toml` `[dependencies]` add:

```toml
tauri-plugin-dialog = "2"
```

In `src-tauri/src/lib.rs`, add to the builder chain inside `run()` (before `.invoke_handler`):

```rust
.plugin(tauri_plugin_dialog::init())
```

In `src-tauri/capabilities/default.json`, ensure `"permissions"` includes:

```json
"dialog:default"
```

- [ ] **Step 6: Verify Rust still builds**

Run: `cd src-tauri && cargo build`
Expected: builds cleanly (downloads `tauri-plugin-dialog`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/files.ts src/lib/files.test.ts src-tauri
git commit -m "feat: add file open/save orchestration and dialog plugin"
```

---

### Task 5: Editor and StatusBar components

Wraps Milkdown Crepe and adds the status bar. Verified manually (Crepe/ProseMirror does not run reliably under jsdom, so no unit mount test — this is a deliberate choice consistent with the spec's "manual verification" note for the editor wrapper).

**Files:**
- Create: `src/Editor.svelte`
- Create: `src/StatusBar.svelte`

**Interfaces:**
- Consumes: `Crepe` from `@milkdown/crepe`; `DocState` shape via props.
- Produces:
  - `Editor.svelte` props: `{ initialContent: string; onChange: (markdown: string) => void }`. Reads `initialContent` once on mount; emits every markdown change via `onChange`.
  - `StatusBar.svelte` props: `{ path: string | null; dirty: boolean; content: string }`. Renders filename (or `Untitled`), a dirty dot, and a live word count.

- [ ] **Step 1: Implement `Editor.svelte`**

Create `src/Editor.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Crepe } from '@milkdown/crepe'
  import '@milkdown/crepe/theme/common/style.css'
  import '@milkdown/crepe/theme/frame.css'

  interface Props {
    initialContent: string
    onChange: (markdown: string) => void
  }
  let { initialContent, onChange }: Props = $props()

  let el: HTMLDivElement
  let crepe: Crepe | undefined

  onMount(async () => {
    crepe = new Crepe({ root: el, defaultValue: initialContent })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChange(markdown))
    })
    await crepe.create()
  })

  onDestroy(() => crepe?.destroy())
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor { height: 100%; overflow: auto; }
</style>
```

- [ ] **Step 2: Implement `StatusBar.svelte`**

Create `src/StatusBar.svelte`:

```svelte
<script lang="ts">
  interface Props {
    path: string | null
    dirty: boolean
    content: string
  }
  let { path, dirty, content }: Props = $props()

  const filename = $derived(path ? path.split('/').pop() : 'Untitled')
  const words = $derived(content.trim() ? content.trim().split(/\s+/).length : 0)
</script>

<footer class="status">
  <span class="name">{filename}{dirty ? ' •' : ''}</span>
  <span class="words">{words} words</span>
</footer>

<style>
  .status {
    display: flex;
    justify-content: space-between;
    padding: 4px 12px;
    font: 12px system-ui, sans-serif;
    border-top: 1px solid #ddd;
    background: #f7f7f7;
  }
</style>
```

- [ ] **Step 3: Verify components compile via a type/build check**

Run: `cd /Users/nicu/Projects/markdon && bunx vite build`
Expected: build succeeds (components are syntactically valid and imports resolve). Wiring into the app happens in Task 6; a temporary unused-component warning is acceptable.

- [ ] **Step 4: Note the HTML-sanitization check (security)**

Milkdown Crepe is built on ProseMirror + Remark, which parse markdown into a structured document model rather than injecting raw HTML — so inline `<script>`/`<img onerror=...>` in markdown is not rendered as live DOM by default. Do NOT enable any raw-HTML passthrough feature. This is verified interactively during the end-of-branch `/verify` pass: paste `<img src=x onerror="alert(1)">` and a `<script>` tag into the editor and confirm no script executes (the strict CSP from Task 8 is the second line of defense). No code change here — this step records the requirement so the reviewer and verifier check it.

- [ ] **Step 5: Commit**

```bash
git add src/Editor.svelte src/StatusBar.svelte
git commit -m "feat: add Milkdown Crepe editor and status bar components"
```

---

### Task 6: Native menu + App wiring

Adds the Rust native menu with accelerators, emits menu events to the frontend, and wires `App.svelte` to drive the store, editor, and file actions.

**Files:**
- Create: `src-tauri/src/menu.rs`
- Modify: `src-tauri/src/lib.rs` (build + set menu in `.setup`, add `on_menu_event`)
- Modify: `src/App.svelte` (replace scaffold with the real app)
- Modify: `src/app.css` (app layout)

**Interfaces:**
- Consumes: menu events `menu:new`, `menu:open`, `menu:save`, `menu:save_as` (emitted from Rust); store + actions from `./lib/document`; `open`/`save`/`saveAs` from `./lib/files`.
- Produces: menu event names above; a fully interactive editor window.

- [ ] **Step 1: Build the menu in Rust**

Create `src-tauri/src/menu.rs`:

```rust
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{App, Wry};

pub fn build(app: &App) -> tauri::Result<Menu<Wry>> {
    let new = MenuItemBuilder::with_id("menu:new", "New")
        .accelerator("CmdOrCtrl+N").build(app)?;
    let open = MenuItemBuilder::with_id("menu:open", "Open…")
        .accelerator("CmdOrCtrl+O").build(app)?;
    let save = MenuItemBuilder::with_id("menu:save", "Save")
        .accelerator("CmdOrCtrl+S").build(app)?;
    let save_as = MenuItemBuilder::with_id("menu:save_as", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "markdon")
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&open)
        .separator()
        .item(&save)
        .item(&save_as)
        .build()?;

    // Native edit items so system shortcuts (copy/paste/undo/redo) work.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])
}
```

- [ ] **Step 2: Wire the menu and event routing into `lib.rs`**

In `src-tauri/src/lib.rs`: add `mod menu;` at the top, `use tauri::Emitter;`, and a `.setup(...)` closure on the builder that sets the menu and routes events:

```rust
.setup(|app| {
    let menu = menu::build(app)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app_handle, event| {
        // Menu item ids ARE the event names (e.g. "menu:open").
        let _ = app_handle.emit(event.id().0.as_str(), ());
    });
    Ok(())
})
```

- [ ] **Step 3: Allow the menu events in capabilities**

In `src-tauri/capabilities/default.json`, ensure `"permissions"` includes event listening (needed for the frontend `listen`):

```json
"core:event:default"
```

- [ ] **Step 4: Replace `App.svelte` with the real app**

Create/overwrite `src/App.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { document, edit, newDoc } from './lib/document'
  import { open, save, saveAs } from './lib/files'
  import Editor from './Editor.svelte'
  import StatusBar from './StatusBar.svelte'

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => newDoc()),
      listen('menu:open', () => open()),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
    ])
    return () => { unsub.then((fns) => fns.forEach((f) => f())) }
  })
</script>

<main class="app">
  {#key $document.loadId}
    <Editor initialContent={$document.content} onChange={edit} />
  {/key}
  <StatusBar path={$document.path} dirty={$document.dirty} content={$document.content} />
</main>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
</style>
```

- [ ] **Step 5: Set base app layout**

Overwrite `src/app.css`:

```css
:root { font-family: system-ui, sans-serif; }
html, body { margin: 0; height: 100%; }
#app { height: 100%; }
```

- [ ] **Step 6: Verify it compiles (automated) + note the interactive checklist**

Automated check (do **not** launch `bun run tauri dev` in a non-interactive session — it blocks on a GUI window):

```bash
cd /Users/nicu/Projects/markdon
bunx tauri build --no-bundle
```

Expected: Vite build + Rust compile succeed.

Interactive verification (deferred to the end-of-branch human `/verify` pass; run `bun run tauri dev` and check each):
- Window shows the Crepe editor + status bar reading `Untitled`.
- Type text → renders WYSIWYG (e.g. `# ` becomes a heading); status bar shows `•` and word count climbs.
- **File → Save** (⌘S) → native save dialog → save → `•` disappears, status bar shows filename.
- Edit → **File → Open** (⌘O) → open the saved file → editor reloads its content.
- **File → New** (⌘N) → editor clears to an empty document.

- [ ] **Step 7: Commit**

```bash
git add src-tauri src/App.svelte src/app.css
git commit -m "feat: add native menu and wire editor, store, and file actions"
```

---

### Task 7: Unsaved-changes guard + error banner

Adds the close-request interception (Rust) and an in-app error banner + discard-confirm modal (Svelte). No native `confirm`.

**Files:**
- Modify: `src-tauri/src/lib.rs` (intercept `CloseRequested`, emit `window:close-requested`)
- Modify: `src-tauri/capabilities/default.json` (allow `window.destroy`)
- Create: `src/lib/errors.ts` (error message store)
- Create: `src/Banner.svelte` (error banner)
- Modify: `src/lib/files.ts` (report failures to the error store)
- Modify: `src/App.svelte` (close-guard modal + banner)

**Interfaces:**
- Consumes: `getCurrentWindow` from `@tauri-apps/api/window`; `window:close-requested` event; `document` store.
- Produces:
  - `src/lib/errors.ts`: `const errorMessage: Writable<string | null>` + `function reportError(msg: string): void` + `function clearError(): void`.
  - `window:close-requested` event from Rust.

- [ ] **Step 1: Intercept the window close in Rust**

In `src-tauri/src/lib.rs`, add `use tauri::Manager;` and extend the `.setup` closure (after the menu wiring) to attach a window handler:

```rust
let window = app.get_webview_window("main").unwrap();
let handle = app.handle().clone();
window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = handle.emit("window:close-requested", ());
    }
});
```

- [ ] **Step 2: Allow `window.destroy` from JS**

In `src-tauri/capabilities/default.json`, add to `"permissions"`:

```json
"core:window:allow-destroy"
```

- [ ] **Step 3: Verify Rust builds**

Run: `cd src-tauri && cargo build`
Expected: builds cleanly.

- [ ] **Step 4: Add the error store**

Create `src/lib/errors.ts`:

```ts
import { writable, type Writable } from 'svelte/store'

export const errorMessage: Writable<string | null> = writable(null)

export function reportError(msg: string): void {
  errorMessage.set(msg)
}

export function clearError(): void {
  errorMessage.set(null)
}
```

- [ ] **Step 5: Report I/O failures from `files.ts`**

In `src/lib/files.ts`, import the reporter and wrap the `invoke` calls so read/write failures surface instead of throwing silently. Add at the top:

```ts
import { reportError } from './errors'
```

Change the body of `open` to guard the read:

```ts
export async function open(): Promise<void> {
  const selected = await openDialog({ filters: [MD_FILTER], multiple: false, directory: false })
  if (typeof selected !== 'string') return
  try {
    const content = await invoke<string>('read_file', { path: selected })
    openDoc(selected, content)
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}
```

Wrap the write in `save` (keep the Save-As fallthrough above the try):

```ts
export async function save(): Promise<void> {
  const state = get(document)
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
```

Wrap the write in `saveAs`:

```ts
export async function saveAs(): Promise<void> {
  const state = get(document)
  const selected = await saveDialog({ filters: [MD_FILTER], defaultPath: state.path ?? 'untitled.md' })
  if (selected === null) return
  try {
    await invoke('write_file', { path: selected, contents: state.content })
    markSaved(selected)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
```

- [ ] **Step 6: Update `files.test.ts` for the failure path and re-run**

Add to `src/lib/files.test.ts`:

```ts
import { errorMessage } from './errors'

describe('error handling', () => {
  it('reports an error when read_file rejects', async () => {
    errorMessage.set(null)
    openDialog.mockResolvedValue('/tmp/a.md')
    invoke.mockRejectedValue('boom')
    await open()
    expect(get(errorMessage)).toContain('Could not open file')
  })

  it('reports an error when write_file rejects and keeps dirty', async () => {
    errorMessage.set(null)
    document.set({ path: '/tmp/a.md', content: 'body', dirty: true, loadId: 1 })
    invoke.mockRejectedValue('disk full')
    await save()
    expect(get(errorMessage)).toContain('Could not save file')
    expect(get(document).dirty).toBe(true)
  })
})
```

Run: `bun run test`
Expected: PASS — all prior tests plus the two new failure-path tests.

- [ ] **Step 7: Add the error banner component**

Create `src/Banner.svelte`:

```svelte
<script lang="ts">
  import { errorMessage, clearError } from './lib/errors'
</script>

{#if $errorMessage}
  <div class="banner" role="alert">
    <span>{$errorMessage}</span>
    <button onclick={clearError} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 12px;
    background: #fdecea;
    color: #611a15;
    font: 13px system-ui, sans-serif;
  }
  button { border: none; background: none; font-size: 16px; cursor: pointer; }
</style>
```

- [ ] **Step 8: Add the close-guard modal + banner to `App.svelte`**

Update `src/App.svelte`: add imports, close-request handling, and markup. Replace the `<script>` and `<main>` with:

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { get } from 'svelte/store'
  import { document, edit, newDoc } from './lib/document'
  import { open, save, saveAs } from './lib/files'
  import Editor from './Editor.svelte'
  import StatusBar from './StatusBar.svelte'
  import Banner from './Banner.svelte'

  let confirmClose = $state(false)

  onMount(() => {
    const unsub = Promise.all([
      listen('menu:new', () => newDoc()),
      listen('menu:open', () => open()),
      listen('menu:save', () => save()),
      listen('menu:save_as', () => saveAs()),
      listen('window:close-requested', () => {
        if (get(document).dirty) confirmClose = true
        else getCurrentWindow().destroy()
      }),
    ])
    return () => { unsub.then((fns) => fns.forEach((f) => f())) }
  })

  function discardAndClose() { getCurrentWindow().destroy() }
  function cancelClose() { confirmClose = false }
</script>

<main class="app">
  <Banner />
  {#key $document.loadId}
    <Editor initialContent={$document.content} onChange={edit} />
  {/key}
  <StatusBar path={$document.path} dirty={$document.dirty} content={$document.content} />
</main>

{#if confirmClose}
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <p>You have unsaved changes. Discard them and close?</p>
      <div class="actions">
        <button onclick={cancelClose}>Cancel</button>
        <button class="danger" onclick={discardAndClose}>Discard & Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #fff; padding: 20px; border-radius: 8px;
    font: 14px system-ui, sans-serif; max-width: 320px;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .danger { color: #b3261e; }
</style>
```

- [ ] **Step 9: Verify it compiles (automated) + note the interactive checklist**

Automated check (do **not** launch `bun run tauri dev` in a non-interactive session — it blocks on a GUI window):

```bash
cd /Users/nicu/Projects/markdon
bunx tauri build --no-bundle
```

Expected: Vite build + Rust compile succeed.

Interactive verification (deferred to the end-of-branch human `/verify` pass; run `bun run tauri dev` and check each):
- Edit without saving → press ⌘W / click the window close button → modal appears; **Cancel** keeps the window; re-trigger → **Discard & Close** closes it.
- With no unsaved changes, closing the window closes immediately (no modal).
- Trigger a save failure (e.g. Save As into a non-writable path like `/note.md`) → red banner appears with the message; document stays dirty; **×** dismisses the banner.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add unsaved-changes guard and error banner"
```

---

### Task 8: Security hardening (strict CSP + UNC/device path rejection)

Added per a security review of the file-I/O commands and an explicit user decision: the app intentionally reads/writes any user-selected file (native dialog = trust boundary), so we do NOT sandbox to a base dir. Instead we close the real exploit path — script injected into the webview (XSS) silently invoking the file commands — by setting a strict CSP, and we add cheap defense-in-depth against Windows UNC/device paths. (Milkdown HTML-render sanitization is verified in Task 5.)

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`app.security.csp`)
- Modify: `src-tauri/src/commands.rs` (add `reject_unsafe_path` guard + call it in both commands; add tests)

**Interfaces:**
- Consumes: existing `read_file` / `write_file` in `commands.rs`.
- Produces: `fn reject_unsafe_path(path: &str) -> Result<(), String>` (private helper); both commands return `Err` for UNC/device paths before touching disk. Command signatures and the `path` / `contents` parameter names are unchanged.

- [ ] **Step 1: Set a strict CSP**

In `src-tauri/tauri.conf.json`, replace `"csp": null` under `app.security` with (the key protection is `script-src 'self'` — no `unsafe-inline` for scripts — so injected inline `<script>`/handlers cannot run and reach the IPC commands; Milkdown needs inline **styles**, hence `style-src ... 'unsafe-inline'`):

```json
"security": {
  "csp": "default-src 'self'; img-src 'self' asset: http://asset.localhost data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; font-src 'self' data:"
}
```

- [ ] **Step 2: Write the failing path-guard tests**

Add to the `tests` module in `src-tauri/src/commands.rs`:

```rust
#[test]
fn read_file_rejects_unc_path() {
    let res = read_file(r"\\evil-server\share\x".to_string());
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("UNC"));
}

#[test]
fn write_file_rejects_unc_path() {
    let res = write_file(r"\\evil-server\share\x".to_string(), "x".into());
    assert!(res.is_err());
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri && cargo test`
Expected: FAIL — the UNC path is currently passed straight to `fs`, so it does not return an error containing "UNC" (on macOS the write/read errors with an OS message, not our guard; the `.contains("UNC")` assertion fails).

- [ ] **Step 4: Add the guard and call it**

In `src-tauri/src/commands.rs`, add the helper and call it at the top of each command:

```rust
/// Reject UNC and DOS device paths (Windows SSRF / NTLM-credential-theft vector).
/// Backslash-prefixed paths are never legitimate on unix, so they are rejected on
/// all platforms; forward-slash UNC and verbatim device prefixes matter on Windows.
fn reject_unsafe_path(path: &str) -> Result<(), String> {
    if path.starts_with(r"\\") {
        return Err("Refusing UNC path".into());
    }
    #[cfg(windows)]
    if path.starts_with("//") || path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        return Err("Refusing UNC or device path".into());
    }
    Ok(())
}
```

Then add `reject_unsafe_path(&path)?;` as the first line of both `read_file` and `write_file` (before the `fs::` call).

- [ ] **Step 5: Run to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS — all prior tests plus the two UNC-rejection tests. Output pristine.

- [ ] **Step 6: Verify the app still compiles with the CSP**

Run: `cd /Users/nicu/Projects/markdon && bunx tauri build --no-bundle`
Expected: Vite build + Rust compile succeed. (Interactive note: on `bun run tauri dev`, confirm the Crepe editor still renders and styles apply — Milkdown's inline styles are permitted by `style-src 'unsafe-inline'`. If Vite dev HMR is blocked by the CSP, add dev-only allowances; production `'self'` is the security-relevant config.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri
git commit -m "feat: harden file commands with strict CSP and UNC path rejection"
```

---

## Self-Review

**Spec coverage:**
- Security hardening (strict CSP, UNC/device path rejection, sanitization check) → Task 8 (+ Task 5 note). ✓
- WYSIWYG inline editing (Milkdown Crepe) → Task 5, Task 6. ✓
- Single-file open/save/save-as via native dialogs → Task 4 (orchestration), Task 2 (I/O). ✓
- Native menu with accelerators (⌘N/⌘O/⌘S/⌘⇧S) → Task 6. ✓
- Document store `{ path, content, dirty, loadId }` + transitions → Task 3. ✓
- Editor re-mount via `{#key loadId}` → Task 6 Step 4. ✓
- Error handling with non-blocking banner, no JS `alert`/`confirm` → Task 7. ✓
- Unsaved-changes guard via `CloseRequested` + in-app modal → Task 7. ✓
- StatusBar (filename, dirty dot, word count) → Task 5. ✓
- All disk access confined to Rust `commands.rs` → Task 2. ✓
- Rust `tempdir` tests; Vitest for store + orchestration → Tasks 2, 3, 4, 7. ✓
- Component structure (`document.ts`, `files.ts`, `Editor`, `StatusBar`, `App`) → matches spec §"Components". ✓

**Deliberate spec deviation:** the spec floats a "light mount test" for `Editor.svelte`; this plan verifies the editor manually instead (Task 5), because Crepe/ProseMirror does not run reliably under jsdom and a brittle mount test would add heavy deps for little value. Consistent with the spec's own "manual verification" clause for the wrapper.

**Placeholder scan:** no TBD/TODO left in deliverable code. (`todo!()` in Task 2 Step 2 is an intentional red-to-green TDD stub, replaced in Step 4.)

**Type consistency:** `DocState` fields (`path`, `content`, `dirty`, `loadId`) are used identically across Tasks 3, 4, 6, 7. Rust command names/params (`read_file(path)`, `write_file(path, contents)`) match the frontend `invoke` keys in `files.ts`. Menu item ids (`menu:new/open/save/save_as`) equal the emitted event names and the `listen` names in `App.svelte`. `errorMessage` / `reportError` / `clearError` consistent across `errors.ts`, `files.ts`, `Banner.svelte`.
