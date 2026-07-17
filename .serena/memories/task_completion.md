# Task Completion

Before considering a change done, run the checks relevant to what changed:

- Frontend (TS/Svelte) logic: `bun run test` (vitest) — must pass.
- Rust (`src-tauri/`): `cd src-tauri && cargo test` — must pass, pristine output.
- Types (any `.svelte`/`.ts`): `bunx svelte-check --tsconfig ./tsconfig.app.json` — 0 errors.
- Anything touching Rust or the build: `bunx tauri build --no-bundle` — Vite build + Rust compile must succeed. (Do NOT use `bun run tauri dev` for verification in a non-interactive session — it blocks on a GUI.)

Runtime/UX changes (editor rendering, menus, dialogs) are only fully verifiable in the actual app: `bun run tauri dev` for native features, or `bun run dev` + a browser at localhost:1420 for frontend-only behavior (Tauri `invoke`/`listen` throw outside the Tauri runtime — expected).
