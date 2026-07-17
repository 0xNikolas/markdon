mod commands;
mod menu;

use tauri::Emitter;
use tauri::Manager;

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

      let window = app.get_webview_window("main").unwrap();
      let handle = app.handle().clone();
      window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = handle.emit("window:close-requested", ());
        }
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
