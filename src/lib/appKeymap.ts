import { get } from 'svelte/store'
import { doc } from './doc'
import { openList, previewPath } from './openList'
import { save, saveAs, openPath } from './files'
import { exportDocument } from './export'
import { revealLog } from './errors'
import { openWorkspace, closeWorkspace, openRecentWorkspace } from './workspace'
import { activeOverlay, openOverlay, closeOverlay, anyOverlayOpen } from './overlay'
import { emptyState } from './ui'
import { isMacPlatform } from './keys'
import { searchUi, closeFind } from './searchPlugin'
import { clearPendingLine } from './sourceEditor'
import {
  closeTabDecision,
  syncReadonlyMenu,
  drainOpenedFiles,
  type MenuEventMap,
} from './appBoot'
import { matchKeydown, menuItemIds, type KeydownGuard } from './keymap'
import type { Routed } from './windowing'

/**
 * The keymap/menu PLUMBING extracted out of App.svelte: the `menu:<id>` routing
 * table, the keyboard-fallback run() bodies, the guard interpreter, and the
 * window keydown driver. It is the DRIVER, not the DATA — the declarative
 * KEYMAP itself stays in keymap.ts. Everything here reads the same stable
 * store/lib singletons appBoot.ts imports; the App-owned flow closures (the
 * ones that close over App's $state / guarded / flushBufferEdits) are passed in
 * as {@link KeymapActions}. App calls {@link createKeymapWiring} once, wires the
 * returned menuEvents into bootApp and handleWindowKeydown onto the window.
 */

/**
 * App-owned flow closures the keymap/menu plumbing delegates to. All of these
 * close over App state (guarded/flushBufferEdits/local $state) so they cannot
 * be imported; App passes them in. `save`/`saveAs`/`exportDocument`/workspace
 * opens/etc. are NOT here — they are stable lib singletons the module imports.
 */
export interface KeymapActions {
  /** File > New / empty-page New (switch-guarded newDoc). */
  newUntitled: () => void
  /** File > Open… (switch-guarded open dialog). */
  openFileDialog: () => void
  /** Cmd+F mode-aware routing (split → CodeMirror; WYSIWYG → FindBar). */
  routeFind: () => void
  /** Cmd+Alt+F mode-aware routing. */
  routeFindReplace: () => void
  /** File-menu Read-Only toggle handler. */
  toggleReadonly: () => void
  /** ⌘P Quick Open (tree-gated). */
  openQuickOpen: () => void
  /** Close a strip row / the active tab (stays in App). */
  onCloseFile: (path: string) => void
  /** The switch-shaped discard guard (stays in App). */
  switchGuarded: (action: () => void) => void
  /** Native close + File > Close Window. */
  closeThisWindow: () => void
  /** Cmd/Ctrl+Shift+T (async; the keydown call-site voids it). */
  reopenClosedFile: () => void
  /** Ctrl+Tab / brackets: cycle the Open Files strip. */
  cycleFiles: (dir: 1 | -1) => void
  /** In-place open for a drained startup/Finder file. */
  openStartupFile: (path: string, readonly: boolean) => void
}

export interface KeymapWiring {
  /** window:close-requested, file:opened, then menu:<id> in menuItemIds() order. */
  menuEvents: MenuEventMap
  handleWindowKeydown: (e: KeyboardEvent) => void
}

// The one gate for document-shaped actions while the empty page is shown:
// there is no document (and no mounted editor) for them to act on, so they
// must no-op cleanly. Gated here: save / save-as (would open a Save As
// dialog for a doc that doesn't exist), export (same, via the menu; the
// Header button's tick is dropped in appBoot's initExportOnTick), find /
// find-replace / go-to-line (would open search or jump UI over a missing
// editor), and the read-only toggle (would lock the hidden scratch and
// render the read-only bar — its handler below also re-syncs the native
// check mark, so it keeps its own branch). Already safe WITHOUT a gate:
// File History (its path===null check covers the empty page's pristine
// scratch), Close Tab (falls through to close-window — correct VS Code
// behavior), and the Header's Split Preview toggle (a bare preference flip;
// no editor is mounted to react, and the next open honoring it is the
// toggle's normal meaning).
const unlessEmpty = (fn: () => void) => () => {
  if (get(emptyState)) return
  fn()
}

/**
 * Build the menu-event map and the window keydown driver from App's flow
 * closures. `isMacPlatform()` is evaluated ONCE here (component-init timing,
 * same as App's old top-level `macPlatform`).
 */
export function createKeymapWiring(actions: KeymapActions): KeymapWiring {
  // menu:<id> routing table — the exact closures the hand-written menuEvents
  // map used, now keyed by bare id so the menu subscription can be DERIVED from
  // the one keymap (keymap.ts's menuItemIds). App still owns these closures
  // because they close over its stores/helpers. Each per-action guard
  // (unlessEmpty, the history/readonly/close_tab inline gates) stays INSIDE its
  // closure: menu routes deliberately gate DIFFERENTLY from the keyboard
  // fallbacks — e.g. a native Cmd+Alt+F emits menu:find_replace even behind an
  // overlay (no overlay gate), while the Cmd+Alt+F keydown fallback does gate —
  // so the two must not share the keydown driver's guard.
  const menuActions: Record<string, (payload?: Routed | null) => void> = {
    new: actions.newUntitled,
    open: actions.openFileDialog,
    save: unlessEmpty(() => void save()),
    save_as: unlessEmpty(() => void saveAs()),
    find: unlessEmpty(actions.routeFind),
    find_replace: unlessEmpty(actions.routeFindReplace),
    goto_line: unlessEmpty(() => {
      // The native Edit menu item isn't disabled by app state (menu.rs has no
      // such wiring), so it stays clickable while another overlay is up.
      // openOverlay enforces mutual exclusion at the store: it refuses (no-op)
      // if one is already open, so Go to Line can't stack its focus trap behind
      // the discard guard / Settings / History (DEFECT A1).
      openOverlay({ kind: 'goto' })
    }),
    history: () => {
      // Untitled/never-saved docs have no history — the menu item no-ops. The
      // same check already covers the empty page (its underlying scratch is
      // pathless), so no unlessEmpty gate is needed here. openOverlay handles
      // modal precedence (refuses if any overlay is open).
      if (get(doc).path === null) return
      openOverlay({ kind: 'history' })
    },
    toggle_readonly: () => {
      // The native menu item is always clickable, and muda optimistically flips
      // its check on click before this fires. Read-only isn't itself an overlay
      // (toggleReadonly may OPEN the discard guard via the dirty path), so this
      // can't lean on openOverlay's refusal — it gates on anyOverlayOpen()
      // directly, plus the empty page (no document to lock). When blocked,
      // re-sync the check to the store's real value to undo muda's optimistic
      // flip (the store didn't change, so the subscription won't).
      if (anyOverlayOpen() || get(emptyState)) {
        syncReadonlyMenu(get(doc).readonly)
        return
      }
      actions.toggleReadonly()
    },
    // Deliberately NOT unlessEmpty-gated: Quick Open must work from the empty
    // page when a workspace exists (see openQuickOpen's own gate).
    quick_open: actions.openQuickOpen,
    settings: () => openOverlay({ kind: 'settings' }),
    open_folder: () => openWorkspace(),
    close_folder: () => closeWorkspace(),
    open_recent: (p) => {
      const root = p?.root
      if (typeof root === 'string') void openRecentWorkspace(root)
    },
    show_log: () => revealLog(),
    close_tab: () => {
      // The Cmd+W routing rules live in closeTabDecision (appBoot.ts).
      const d = closeTabDecision(get(doc).path, get(previewPath), get(openList))
      switch (d.kind) {
        case 'close-file':
          actions.onCloseFile(d.path)
          break
        case 'reopen-preview':
          actions.switchGuarded(() => openPath(d.path, { preview: true }))
          break
        case 'reopen-pinned':
          actions.switchGuarded(() => openPath(d.path))
          break
        case 'close-window':
          actions.closeThisWindow()
          break
      }
    },
    close_window: actions.closeThisWindow,
    export: unlessEmpty(() => void exportDocument()),
  }

  // The keyboard-fallback action for each keymap id that has a JS match. These
  // are the run() bodies moved verbatim from the old if-chain; the keymap's
  // match/guard/preventDefault flags decide WHEN each fires (see the driver
  // below). Distinct from menuActions: the keydown Find/Find-and-Replace/Go-to-
  // Line runs are UNgated here (the driver applies their overlay/empty guards),
  // whereas the menu variants wrap themselves in unlessEmpty.
  const keydownActions: Record<string, () => void> = {
    quick_open: actions.openQuickOpen,
    reopen_closed: () => void actions.reopenClosedFile(),
    file_cycle_next: () => actions.cycleFiles(1),
    file_cycle_prev: () => actions.cycleFiles(-1),
    find_replace: actions.routeFindReplace,
    find: actions.routeFind,
    goto_line: () => openOverlay({ kind: 'goto' }),
  }

  // Resolve a matched binding's guard against live app state — the exact
  // conditions the old if-chain used inline:
  //   'overlay'       -> Quick Open / Reopen: skip while any overlay is up.
  //   'overlay-empty' -> file cycle / Find-and-Replace / Go to Line: skip
  //                      behind an overlay OR on the empty page.
  //   'empty'         -> Find: only the empty-page gate (it deliberately claims
  //                      Cmd/Ctrl+F even while other surfaces are open).
  function keydownGuardOk(guard: KeydownGuard | undefined): boolean {
    switch (guard) {
      case 'overlay':
        return !anyOverlayOpen()
      case 'overlay-empty':
        return !anyOverlayOpen() && !get(emptyState)
      case 'empty':
        return !get(emptyState)
      default:
        return true
    }
  }

  // The window keydown driver. The one declarative keymap (keymap.ts) decides
  // WHAT matches and HOW it is guarded/claimed; this only interprets the flags:
  //
  //  - matchKeydown runs the table in order, first match wins — preserving the
  //    load-bearing precedence (Find-and-Replace before Find, so Cmd+Alt+F is
  //    never mis-claimed by the looser Find matcher on platforms where Option
  //    doesn't remap e.key).
  //  - preventDefault:'always' claims the combo BEFORE the guard check (so
  //    Cmd/Ctrl+P, Ctrl+Tab and Cmd+Shift+T/brackets never leak to the
  //    webview's print/focus-traversal/reopen defaults even when the action
  //    no-ops); 'onRun' claims it only after the guard passes (Find / Find-and-
  //    Replace / Go to Line return WITHOUT preventDefault when gated out).
  //
  // The two Escape fallbacks stay INLINE below (not in the pure table): they
  // read live searchUi / activeOverlay, not just the event. They sit after
  // the empty-page gate, exactly as before — closing the find bar (WYSIWYG;
  // CodeMirror owns its own panel's Esc in split mode) or the Go to Line
  // popover.
  const macPlatform = isMacPlatform()
  function handleWindowKeydown(e: KeyboardEvent) {
    const hit = matchKeydown(e, macPlatform)
    if (hit) {
      const ok = keydownGuardOk(hit.keydownGuard)
      if (hit.preventDefault === 'always') {
        e.preventDefault()
        if (!ok) return
      } else {
        if (!ok) return
        e.preventDefault()
      }
      keydownActions[hit.id]?.()
      return
    }
    // No table match. The remaining Escape fallbacks are document/editor
    // actions, so the empty page gates them out — the same gate the menu routes
    // get via unlessEmpty.
    if (get(emptyState)) return
    if (e.key === 'Escape' && get(searchUi).open && get(activeOverlay)?.kind !== 'discard') {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'Escape' && get(activeOverlay)?.kind === 'goto') {
      e.preventDefault()
      clearPendingLine()
      closeOverlay()
    }
  }

  // All boot wiring (event subscriptions, startup drains, watcher/workspace
  // init, native-chrome mirrors) lives in appBoot.ts; App supplies only the
  // UI-flow closures the handlers need. The menu:<id> subscriptions are derived
  // from the keymap so the table is the single source; the two non-menu window
  // events (native close, Finder open) are added alongside.
  const menuEvents: MenuEventMap = {
    'window:close-requested': actions.closeThisWindow,
    'file:opened': () => void drainOpenedFiles(actions.openStartupFile),
  }
  for (const id of menuItemIds()) {
    const action = menuActions[id]
    if (action) menuEvents[`menu:${id}`] = action
  }

  return { menuEvents, handleWindowKeydown }
}
