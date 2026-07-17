mod commands;
mod menu;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let menu = menu::build(app)?;
      app.set_menu(menu)?;
      app.on_menu_event(|app_handle, event| {
        // Menu item ids ARE the event names (e.g. "menu:open").
        let _ = app_handle.emit(event.id().0.as_str(), ());
      });

      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::read_file,
      commands::write_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
