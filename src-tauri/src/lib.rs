#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // Exactly one instance, and the reason is not tidiness.
  //
  // Without this, launching the app while it is already running starts a
  // *second* process against the same webview data directory. Both run the
  // client, but only one wins the `messenger.sync` Web Lock and actually
  // syncs; the other is a follower whose UI is told about new and healed
  // messages over a BroadcastChannel -- which does not cross WebView2
  // process boundaries. The loser therefore renders whatever it read at
  // startup and never updates, so decrypted messages keep showing
  // "Encrypted message -- waiting for keys" while the database holds the
  // plaintext. Reported exactly that way, and the reason "restarting it"
  // did not help: relaunching added a process rather than replacing one,
  // leaving the stale window on screen.
  //
  // Registered before every other plugin, as the plugin requires.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    use tauri::Manager;
    // Someone tried to start a second copy: surface the one that exists
    // rather than silently doing nothing, which would read as a launch
    // that failed.
    //
    // Any window rather than the "main" label: tauri.conf.json declares no
    // label, so the one here is Tauri's implicit default, and a config that
    // later names its window should not silently stop this working.
    if let Some(window) = app
      .get_webview_window("main")
      .or_else(|| app.webview_windows().into_values().next())
    {
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
    }
  }));

  builder
    // Registration only -- the JS side (sync/desktop-notify.ts) owns every
    // decision about when a notification is deserved.
    .plugin(tauri_plugin_notification::init())
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
