/**
 * Static list of the app's REAL shortcuts, rendered read-only in the
 * Settings modal's Shortcuts tab. Keep in sync with src-tauri/src/menu.rs
 * accelerators (the app-defined ones) plus the native Edit-menu items.
 * split-preview appends its Shift+Cmd+P entry when it lands.
 */
export interface Shortcut {
  label: string
  keys: string[]
  /** Optional one-liner clarifying what the action does (shown muted). */
  note?: string
}

export const APP_SHORTCUTS: Shortcut[] = [
  { label: 'New File', keys: ['Cmd', 'N'] },
  { label: 'Open…', keys: ['Cmd', 'O'] },
  { label: 'Quick Open…', keys: ['Cmd', 'P'] },
  // Keyboard-only (no menu item); the Shortcut shape carries ONE combo, so
  // the bracket pair is listed as primary and Ctrl+Tab rides the note.
  {
    label: 'Next Open File',
    keys: ['Cmd', 'Shift', ']'],
    note: 'Cycles the Open Files strip in row order, wrapping. Ctrl+Tab also works.',
  },
  {
    label: 'Previous Open File',
    keys: ['Cmd', 'Shift', '['],
    note: 'Same cycle, backwards. Ctrl+Shift+Tab also works.',
  },
  { label: 'Save', keys: ['Cmd', 'S'] },
  { label: 'Save As…', keys: ['Cmd', 'Shift', 'S'] },
  {
    label: 'Export…',
    keys: ['Cmd', 'Shift', 'E'],
    note: 'Exports the current format; PDF opens the macOS print dialog (Save as PDF).',
  },
  { label: 'Find', keys: ['Cmd', 'F'] },
  {
    label: 'Find and Replace…',
    keys: ['Cmd', 'Alt', 'F'],
    note: 'WYSIWYG opens the find bar with the replace row expanded; split mode uses the CodeMirror native panel.',
  },
  {
    label: 'Go to Line…',
    keys: ['Cmd', 'L'],
    note: 'Accepts a line, or line:col (col is 0-based, matching the status bar).',
  },
  {
    label: 'File History…',
    keys: ['Cmd', 'Shift', 'H'],
    note: 'View and revert to previous saved versions; revert loads as unsaved changes.',
  },
  { label: 'Settings', keys: ['Cmd', ','] },
  { label: 'Undo', keys: ['Cmd', 'Z'] },
  { label: 'Redo', keys: ['Cmd', 'Shift', 'Z'] },
  { label: 'Cut', keys: ['Cmd', 'X'] },
  { label: 'Copy', keys: ['Cmd', 'C'] },
  { label: 'Paste', keys: ['Cmd', 'V'] },
  { label: 'Select All', keys: ['Cmd', 'A'] },
]
