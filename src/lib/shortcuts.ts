/**
 * Back-compat shim. The app's real shortcuts now live in ONE declarative table
 * — src/lib/keymap.ts — which drives the window keydown handler, the menu-event
 * routing, and the Settings Shortcuts list alike. This module re-exports the
 * Settings view of that table so any older `import … from './shortcuts'` keeps
 * resolving; new code should import from './keymap' directly.
 */
export type { Shortcut } from './keymap'
export { settingsList } from './keymap'
