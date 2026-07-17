# Suggested Commands

Run from repo root unless noted. **Use bun, not npm/npx.**

- Install deps: `bun install`; add dep `bun add X`; add dev dep `bun add -d X`.
- Frontend dev server (browser, no native APIs): `bun run dev` → http://localhost:1420
- Full app (native window): `bun run tauri dev` — **blocks on a GUI window; do not run in a non-interactive/agent session** (it hangs). Closing the window stops it.
- Frontend unit tests: `bun run test` (= `vitest run`).
- Rust tests: `cd src-tauri && cargo test`.
- Type-check Svelte/TS: `bunx svelte-check --tsconfig ./tsconfig.app.json`.
- Compile check without launching GUI (Vite build + Rust release): `bunx tauri build --no-bundle`.
- Frontend-only prod build: `bunx vite build`.

Darwin note: BSD userland; `git ls-files` for listing. The `error messaging the mach port for IMKCFRunLoopWakeUpReliable` line on `tauri dev` launch is a benign macOS IME warning, not an app error.
