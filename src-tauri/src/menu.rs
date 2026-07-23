use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{App, AppHandle, Manager, Wry};

/// Builds the app menu and returns it alongside the "Read Only" CheckMenuItem
/// and the "Open Recent" Submenu handles. `Menu::get` only walks top-level
/// submenus, not nested items, so neither can be looked up by id after the
/// fact — the caller stores both handles in managed state: the readonly item's
/// checked state is driven from the doc store via `set_readonly_menu_state`,
/// and the Open Recent submenu's items are rebuilt from workspace.json via
/// `sync_recent_menu`.
#[allow(clippy::type_complexity)]
pub fn build(app: &App) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>, Submenu<Wry>)> {
    let new = MenuItemBuilder::with_id("menu:new", "New")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("menu:open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("menu:open_folder", "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    // Built empty: sync_recent_menu fills it from workspace.json at setup and
    // after every MRU change. Items are click-only (no accelerators), so the
    // accelerator-collision tests below stay untouched.
    let open_recent =
        SubmenuBuilder::with_id(app, "menu:open_recent_submenu", "Open Recent").build()?;
    let save = MenuItemBuilder::with_id("menu:save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("menu:save_as", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    // No accelerator: this is a mode toggle reached from the menu (and the
    // banner's "Enable editing" button), not a hot-path keystroke, and every
    // trivial Cmd+<letter> is already taken or collides with a
    // PredefinedMenuItem default — so it is deliberately menu-only and gets no
    // Shortcuts-tab entry. `checked(false)` overrides the builder's default of
    // `true`; the real state is pushed from the doc store on mount and on every
    // readonly change.
    let readonly = CheckMenuItemBuilder::with_id("menu:toggle_readonly", "Read Only")
        .checked(false)
        .build(app)?;
    // NOT CmdOrCtrl+Y: muda's PredefinedMenuItem::redo (below) defaults to
    // CmdOrCtrl+Y on every platform except macOS (macOS gets Cmd+Shift+Z), so
    // Ctrl+Y would collide with Edit > Redo on Windows/Linux and make one of
    // the two keyboard-unreachable. Cmd/Ctrl+Shift+H doesn't collide with any
    // PredefinedMenuItem default (undo/redo/cut/copy/paste/select_all/quit)
    // or any other accelerator in this file.
    let history = MenuItemBuilder::with_id("menu:history", "File History…")
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;
    let export = MenuItemBuilder::with_id("menu:export", "Export…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let find = MenuItemBuilder::with_id("menu:find", "Find…")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let goto_line = MenuItemBuilder::with_id("menu:goto_line", "Go to Line…")
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let find_replace = MenuItemBuilder::with_id("menu:find_replace", "Find and Replace…")
        .accelerator("CmdOrCtrl+Alt+F")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("menu:settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    // Close trio, VS Code order/keys: Cmd+W closes the active tab (or, with no
    // file open, the window), Cmd+Shift+W closes the window. Neither collides
    // with a PredefinedMenuItem default because this menu never builds muda's
    // predefined close_window/hide items (whose macOS defaults would claim
    // Cmd+W / Cmd+H). Close Folder is deliberately accelerator-less like the
    // readonly toggle: a rare mode change, not a hot-path keystroke.
    let close_tab = MenuItemBuilder::with_id("menu:close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let close_window = MenuItemBuilder::with_id("menu:close_window", "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let close_folder = MenuItemBuilder::with_id("menu:close_folder", "Close Folder").build(app)?;
    // No accelerator: a rare diagnostic action, matching the readonly /
    // close_folder precedent — keeps the accelerator-collision tests untouched.
    let show_log = MenuItemBuilder::with_id("menu:show_log", "Show Log").build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Markdon")
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&open)
        .item(&open_folder)
        .item(&open_recent)
        .separator()
        .item(&save)
        .item(&save_as)
        .item(&readonly)
        .separator()
        .item(&history)
        .separator()
        .item(&export)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .item(&close_folder)
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
        .separator()
        .item(&find)
        .item(&find_replace)
        .separator()
        .item(&goto_line)
        .build()?;

    // A plain submenu titled "Help": macOS's native Help-search field would
    // need muda's set_as_help_menu_for_nsapp, deliberately skipped this sprint.
    let help_menu = SubmenuBuilder::new(app, "Help").item(&show_log).build()?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &help_menu])?;
    Ok((menu, readonly, open_recent))
}

/// Index of an Open Recent click: parses `menu:recent:<n>` ids (the position
/// into the `RecentMenu` roots snapshot), `None` for every other menu id.
pub(crate) fn recent_index(id: &str) -> Option<usize> {
    id.strip_prefix("menu:recent:")?.parse().ok()
}

/// Menu label for a recent root: basename, then an em-dash-separated parent
/// directory abbreviated with `~` when under `home`. Deliberately dumb string
/// work so it stays unit-testable without an AppHandle.
pub(crate) fn recent_label(root: &str, home: Option<&str>) -> String {
    let p = std::path::Path::new(root);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or(root);
    let parent = p.parent().and_then(|d| d.to_str()).unwrap_or("");
    let parent = match home.filter(|h| !h.is_empty()) {
        Some(h) if parent == h => "~".to_string(),
        Some(h) if parent.starts_with(&format!("{h}/")) => format!("~{}", &parent[h.len()..]),
        _ => parent.to_string(),
    };
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{name} — {parent}")
    }
}

/// Rebuild the "Open Recent" submenu from workspace.json's MRU. Fire-and-
/// forget: a menu refresh must never fail an open, so every failure is
/// swallowed with a warning. The whole rebuild is dispatched to the MAIN
/// thread: each Submenu item op self-dispatches there anyway (blocking, via
/// tauri's run_item_main_thread), and menu click/focus handlers already run
/// there — so doing the item ops AND the `RecentMenu` roots-snapshot update in
/// one main-thread closure keeps the id->root lookup table atomic with the
/// visible items (a click always resolves against exactly what the menu
/// showed) WITHOUT ever holding the roots lock across a cross-thread dispatch
/// (which could deadlock against a main-thread sync waiting on that lock).
pub fn sync_recent_menu(app: &AppHandle) {
    let app = app.clone();
    let dispatched = app.clone().run_on_main_thread(move || {
        if let Err(e) = sync_recent_menu_on_main(&app) {
            log::warn!("could not refresh the Open Recent menu: {e}");
        }
    });
    if let Err(e) = dispatched {
        log::warn!("could not refresh the Open Recent menu: {e}");
    }
}

/// The main-thread body of [`sync_recent_menu`].
fn sync_recent_menu_on_main(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<crate::RecentMenu>()
        .ok_or_else(|| "RecentMenu state not managed yet".to_string())?;
    let file = crate::workspace::state_file(app)?;
    let roots = crate::workspace::load_state(&file).roots;
    let submenu = &state.submenu;
    while submenu.remove_at(0).map_err(|e| e.to_string())?.is_some() {}
    if roots.is_empty() {
        let placeholder = MenuItemBuilder::new("No Recent Workspaces")
            .enabled(false)
            .build(app)
            .map_err(|e| e.to_string())?;
        submenu.append(&placeholder).map_err(|e| e.to_string())?;
    } else {
        let home = app
            .path()
            .home_dir()
            .ok()
            .and_then(|h| h.to_str().map(str::to_string));
        for (i, root) in roots.iter().enumerate() {
            let item = MenuItemBuilder::with_id(
                format!("menu:recent:{i}"),
                recent_label(root, home.as_deref()),
            )
            .build(app)
            .map_err(|e| e.to_string())?;
            submenu.append(&item).map_err(|e| e.to_string())?;
        }
    }
    *state.roots.lock().unwrap() = roots;
    Ok(())
}

#[cfg(test)]
mod tests {
    // tauri's MenuItemBuilder::accelerator stores the raw string and parses
    // it lazily with `.and_then(|s| s.parse().ok())` -- a bad string is
    // swallowed silently (no accelerator, no error), so `cargo build`/`cargo
    // test` alone wouldn't catch a typo'd accelerator. Parse the exact
    // strings used above directly against muda so a typo in CmdOrCtrl+,
    // (or any other accelerator here) fails loudly instead of silently.
    use std::str::FromStr;

    use super::{recent_index, recent_label};

    #[test]
    fn recent_index_parses_only_recent_ids() {
        assert_eq!(recent_index("menu:recent:0"), Some(0));
        assert_eq!(recent_index("menu:recent:7"), Some(7));
        assert_eq!(recent_index("menu:recent:"), None);
        assert_eq!(recent_index("menu:recent:x"), None);
        assert_eq!(recent_index("menu:recent:-1"), None);
        assert_eq!(recent_index("menu:open_recent_submenu"), None);
        assert_eq!(recent_index("menu:open"), None);
        assert_eq!(recent_index(""), None);
    }

    #[test]
    fn recent_label_is_basename_plus_tilde_abbreviated_parent() {
        assert_eq!(
            recent_label("/Users/me/notes", Some("/Users/me")),
            "notes — ~"
        );
        assert_eq!(
            recent_label("/Users/me/dev/proj", Some("/Users/me")),
            "proj — ~/dev"
        );
        // Outside home (or with no home known): the raw parent.
        assert_eq!(
            recent_label("/srv/data/ws", Some("/Users/me")),
            "ws — /srv/data"
        );
        assert_eq!(recent_label("/srv/data/ws", None), "ws — /srv/data");
        // A sibling sharing home as a string prefix must NOT abbreviate.
        assert_eq!(
            recent_label("/Users/melon/ws", Some("/Users/me")),
            "ws — /Users/melon"
        );
        // Degenerate roots fall back to something legible.
        assert_eq!(recent_label("/", Some("/Users/me")), "/");
    }

    #[test]
    fn settings_accelerator_parses() {
        let accel = muda::accelerator::Accelerator::from_str("CmdOrCtrl+,");
        assert!(accel.is_ok(), "CmdOrCtrl+, failed to parse: {accel:?}");
    }

    #[test]
    fn all_menu_accelerators_parse() {
        for s in [
            "CmdOrCtrl+N",
            "CmdOrCtrl+O",
            "CmdOrCtrl+Shift+O",
            "CmdOrCtrl+S",
            "CmdOrCtrl+Shift+S",
            "CmdOrCtrl+Shift+E",
            "CmdOrCtrl+Shift+H",
            "CmdOrCtrl+F",
            "CmdOrCtrl+Alt+F",
            "CmdOrCtrl+L",
            "CmdOrCtrl+,",
            "CmdOrCtrl+W",
            "CmdOrCtrl+Shift+W",
        ] {
            let accel = muda::accelerator::Accelerator::from_str(s);
            assert!(accel.is_ok(), "{s} failed to parse: {accel:?}");
        }
    }

    // `all_menu_accelerators_parse` only checks each string parses in
    // isolation -- it can't catch two items claiming the same accelerator, or
    // a custom item colliding with a PredefinedMenuItem's OS-default
    // accelerator (which muda assigns internally and never appears as a
    // string literal in this file). That's exactly how the File History item
    // shipped colliding with Edit > Redo on Windows/Linux: muda 0.19.3's
    // PredefinedMenuItem::redo defaults to CmdOrCtrl+Y everywhere except
    // macOS (items/predefined.rs), while macOS gets Cmd+Shift+Z. Guard both
    // failure modes explicitly, normalized case-insensitively since muda's
    // parser (and Accelerator's Display/Eq) treats e.g. "cmdorctrl" and
    // "CmdOrCtrl" as equivalent.
    #[test]
    fn custom_accelerators_have_no_internal_duplicates() {
        let custom = [
            "CmdOrCtrl+N",
            "CmdOrCtrl+O",
            "CmdOrCtrl+Shift+O",
            "CmdOrCtrl+S",
            "CmdOrCtrl+Shift+S",
            "CmdOrCtrl+Shift+E",
            "CmdOrCtrl+Shift+H",
            "CmdOrCtrl+F",
            "CmdOrCtrl+Alt+F",
            "CmdOrCtrl+L",
            "CmdOrCtrl+,",
            "CmdOrCtrl+W",
            "CmdOrCtrl+Shift+W",
        ];
        for (i, a) in custom.iter().enumerate() {
            for (j, b) in custom.iter().enumerate() {
                if i != j {
                    assert_ne!(
                        a.to_lowercase(),
                        b.to_lowercase(),
                        "duplicate accelerator: {a} (items {i} and {j})"
                    );
                }
            }
        }
    }

    #[test]
    fn custom_accelerators_do_not_collide_with_non_macos_predefined_defaults() {
        // muda 0.19.3 items/predefined.rs, #[cfg(not(target_os = "macos"))]
        // defaults for the PredefinedMenuItem variants this app's Edit/App
        // menus actually build (undo/redo/cut/copy/paste/select_all/quit).
        // macOS's own defaults (e.g. redo's Cmd+Shift+Z) never collide with
        // any accelerator string used below, so only the non-mac set needs
        // checking here.
        let predefined_non_macos = [
            "CmdOrCtrl+Z", // undo
            "CmdOrCtrl+Y", // redo -- the one this app's History item hit
            "CmdOrCtrl+X", // cut
            "CmdOrCtrl+C", // copy
            "CmdOrCtrl+V", // paste
            "CmdOrCtrl+A", // select_all
            "CmdOrCtrl+Q", // quit
        ];
        let custom = [
            ("menu:new", "CmdOrCtrl+N"),
            ("menu:open", "CmdOrCtrl+O"),
            ("menu:open_folder", "CmdOrCtrl+Shift+O"),
            ("menu:save", "CmdOrCtrl+S"),
            ("menu:save_as", "CmdOrCtrl+Shift+S"),
            ("menu:history", "CmdOrCtrl+Shift+H"),
            ("menu:export", "CmdOrCtrl+Shift+E"),
            ("menu:find", "CmdOrCtrl+F"),
            ("menu:goto_line", "CmdOrCtrl+L"),
            ("menu:find_replace", "CmdOrCtrl+Alt+F"),
            ("menu:settings", "CmdOrCtrl+,"),
            ("menu:close_tab", "CmdOrCtrl+W"),
            ("menu:close_window", "CmdOrCtrl+Shift+W"),
        ];
        for (id, accel) in custom {
            for predefined in predefined_non_macos {
                assert_ne!(
                    accel.to_lowercase(),
                    predefined.to_lowercase(),
                    "{id}'s accelerator {accel} collides with a PredefinedMenuItem's \
                     non-macOS default ({predefined}) -- unreachable via keyboard on \
                     Windows/Linux since tauri.conf.json bundles for all targets"
                );
            }
        }
    }
}
