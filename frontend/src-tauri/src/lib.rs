use tauri::Manager;

// Create the command to close splashscreen and show the main window
#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) {
  // Close splashscreen window
  if let Some(splashscreen) = app.get_webview_window("splashscreen") {
    splashscreen.close().unwrap();
  }
  // Show main window
  if let Some(main) = app.get_webview_window("main") {
    main.show().unwrap();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![close_splashscreen])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
