/**
 * Static list of the app's REAL shortcuts, rendered read-only in the
 * Settings modal's Shortcuts tab. Keep in sync with src-tauri/src/menu.rs
 * accelerators (the app-defined ones) plus the native Edit-menu items.
 * split-preview appends its Shift+Cmd+P entry when it lands.
 */
export interface Shortcut {
  label: string
  keys: string[]
}

export const APP_SHORTCUTS: Shortcut[] = [
  { label: 'New File', keys: ['Cmd', 'N'] },
  { label: 'Open…', keys: ['Cmd', 'O'] },
  { label: 'Save', keys: ['Cmd', 'S'] },
  { label: 'Save As…', keys: ['Cmd', 'Shift', 'S'] },
  { label: 'Find', keys: ['Cmd', 'F'] },
  { label: 'Settings', keys: ['Cmd', ','] },
  { label: 'Undo', keys: ['Cmd', 'Z'] },
  { label: 'Redo', keys: ['Cmd', 'Shift', 'Z'] },
  { label: 'Cut', keys: ['Cmd', 'X'] },
  { label: 'Copy', keys: ['Cmd', 'C'] },
  { label: 'Paste', keys: ['Cmd', 'V'] },
  { label: 'Select All', keys: ['Cmd', 'A'] },
]
