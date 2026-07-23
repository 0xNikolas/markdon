// Shared constants pinned across the app's Tauri IPC boundary, so the e2e spec
// side references one value instead of hand-copying the backend string. The
// browser-side stub (e2e/support/tauriInternals.js) keeps its own literal
// because it is a dependency-free classic script that can NOT import a module
// (its loading contract: addInitScript{path} + future side-effect script), and
// Rust keeps its literal in fileops.rs. All three copies are held equal by the
// contract test (src/lib/test-support/stubContract.test.ts): any drift goes red.

// fileops.rs's no-clobber gate: performRename surfaces this in the error banner
// (behind the app-side `Could not rename: ` prefix) and the rename-collision
// spec asserts it.
export const NO_CLOBBER = 'a file or folder with that name already exists'
