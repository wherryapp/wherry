// ---------------------------------------------------------------------------
// The keychain vault
// ---------------------------------------------------------------------------
//
// Three passthrough commands to the OS keychain (macOS/iOS Keychain,
// Windows Credential Manager), for the handful of secrets that must
// survive the webview's storage being evicted -- which WebKit is allowed
// to do to an inactive iOS app's IndexedDB, and which would otherwise cost
// the account keypair (the lost-device path) and the device id (a
// phantom-device pile-up on the next login).
//
// This bends the shell's "no IPC, no Rust logic" rule as little as it can:
// there is still no logic here -- what is stored, when, and what any of it
// means lives entirely in client/src/vault.ts. These are dumb string
// get/set/delete on a keychain entry, the same passthrough shape as the
// notification plugin's registration.
//
// On Linux and Android the commands exist but hold nothing (get answers
// None), so the client code is identical everywhere: keyring's
// secret-service backend would add a D-Bus system dependency to CI for the
// one desktop platform whose webview storage is not under eviction
// pressure, and it has no Android backend at all. Android is not a gap
// being tolerated -- its WebView is Chromium, which keeps an installed
// app's storage in the private data dir rather than evicting it the way
// WebKit may for an inactive iOS app.

#[cfg(any(target_vendor = "apple", target_os = "windows"))]
fn vault_entry(key: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new("com.cjtechsystems.messenger", key).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_get(key: String) -> Result<Option<String>, String> {
  #[cfg(any(target_vendor = "apple", target_os = "windows"))]
  {
    match vault_entry(&key)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(e.to_string()),
    }
  }
  #[cfg(not(any(target_vendor = "apple", target_os = "windows")))]
  {
    let _ = key;
    Ok(None)
  }
}

#[tauri::command]
fn vault_set(key: String, value: String) -> Result<(), String> {
  #[cfg(any(target_vendor = "apple", target_os = "windows"))]
  {
    vault_entry(&key)?.set_password(&value).map_err(|e| e.to_string())
  }
  #[cfg(not(any(target_vendor = "apple", target_os = "windows")))]
  {
    let _ = (key, value);
    Ok(())
  }
}

#[tauri::command]
fn vault_delete(key: String) -> Result<(), String> {
  #[cfg(any(target_vendor = "apple", target_os = "windows"))]
  {
    match vault_entry(&key)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(e.to_string()),
    }
  }
  #[cfg(not(any(target_vendor = "apple", target_os = "windows")))]
  {
    let _ = key;
    Ok(())
  }
}

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
    // Registration only, same as notification: the client decides what to
    // open and when (api/shell.ts's openExternal); this provides the API.
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![vault_get, vault_set, vault_delete])
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
