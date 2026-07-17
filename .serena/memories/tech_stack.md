# Tech Stack

Desktop markdown editor.

- **Tauri v2** — desktop shell, Rust core (`src-tauri/`). Crate `tauri = "2"`, `tauri-plugin-dialog = "2"`.
- **Svelte 5** (runes: `$props`, `$state`, `$derived`) + **TypeScript**, bundled with **Vite** (dev server pinned to port 1420, `strictPort`).
- **Milkdown Crepe** (`@milkdown/crepe`) — WYSIWYG markdown editor (ProseMirror + Remark). Themed via CSS vars `--crepe-font-title/default/code`; app overrides them in `src/editor-theme.css` (imported AFTER the Crepe theme in `Editor.svelte`).
- **Package manager & runner: bun** (NOT npm/npx). Lockfile is text `bun.lock` (bun 1.3+), committed.
- **Vitest** — frontend unit tests (`environment: node`, `passWithNoTests: true`). Run via `bun run test`, never `bun test` (Bun's native runner is incompatible with the `vi.mock` APIs used).
