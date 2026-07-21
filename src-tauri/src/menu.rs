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
            "CmdOrCtrl+F",
            "CmdOrCtrl+Alt+F",
            "CmdOrCtrl+L",
            "CmdOrCtrl+,",
        ] {
            let accel = muda::accelerator::Accelerator::from_str(s);
            assert!(accel.is_ok(), "{s} failed to parse: {accel:?}");
        }
    }
}
