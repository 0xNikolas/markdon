use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{App, Wry};

pub fn build(app: &App) -> tauri::Result<Menu<Wry>> {
    let new = MenuItemBuilder::with_id("menu:new", "New")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("menu:open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("menu:open_folder", "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("menu:save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("menu:save_as", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
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

    let app_menu = SubmenuBuilder::new(app, "markdon")
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&open)
        .item(&open_folder)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&history)
        .separator()
        .item(&export)
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

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])
}

#[cfg(test)]
mod tests {
    // tauri's MenuItemBuilder::accelerator stores the raw string and parses
    // it lazily with `.and_then(|s| s.parse().ok())` -- a bad string is
    // swallowed silently (no accelerator, no error), so `cargo build`/`cargo
    // test` alone wouldn't catch a typo'd accelerator. Parse the exact
    // strings used above directly against muda to verify the amendment's
    // "cargo build/test check" duty for CmdOrCtrl+,.
    use std::str::FromStr;

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
