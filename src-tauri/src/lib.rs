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

// The native media transport (docs/prompts/native-media-plan.md, stage 2):
// the first Rust here that is not a passthrough, and the reason the rule
// above is now "decisions in TypeScript, mechanism in Rust, and the
// boundary is a named interface" -- the interface being `VoiceTransport`
// in client/src/voice/transport.ts, with `transport-native.ts` on the
// other side of these commands. Desktop only; the phones keep the webview
// transport and never compile this.
#[cfg(desktop)]
mod voice;

#[cfg(any(target_vendor = "apple", target_os = "windows"))]
fn vault_entry(key: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new("app.wherry", key).map_err(|e| e.to_string())
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

  let builder = builder
    // Registration only -- the JS side (sync/desktop-notify.ts) owns every
    // decision about when a notification is deserved.
    .plugin(tauri_plugin_notification::init())
    // Registration only, same as notification: the client decides what to
    // open and when (api/shell.ts's openExternal); this provides the API.
    .plugin(tauri_plugin_opener::init());

  // One `generate_handler!` per platform shape: the macro takes a single
  // list, and the voice commands exist only where the media crate does.
  #[cfg(not(desktop))]
  let builder =
    builder.invoke_handler(tauri::generate_handler![vault_get, vault_set, vault_delete]);
  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    vault_get,
    vault_set,
    vault_delete,
    voice::voice_probe,
    voice::voice_devices,
    voice::voice_connect,
    voice::voice_disconnect,
    voice::voice_set_mic,
    voice::voice_set_input_device,
    voice::voice_set_output_device,
    voice::voice_set_epoch_key,
    voice::voice_set_playback,
    voice::voice_roster,
    voice::voice_stats,
    voice::voice_pong,
    voice::page_pulse,
    shell_keep_page_visible,
  ]);

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // The boot-time page probe (voice.rs, "the page probe"): debug builds
      // only, desktop only, and the instrument gate 2 of the native media
      // plan is waiting on. It reports; it decides nothing.
      #[cfg(all(desktop, debug_assertions))]
      voice::start_page_probe(app.handle().clone());
      // Debug-only experiment switch for the measurement above: keep the
      // page visible from boot, before TypeScript has decided anything.
      #[cfg(all(target_os = "macos", debug_assertions))]
      if std::env::var("WHERRY_KEEP_AWAKE").ok().as_deref() == Some("1") {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
          set_window_occlusion_detection(&window, false)?;
        }
      }
      // And its opposite number: `WHERRY_HIDE=1` starts with the window hidden,
      // which is the one state that reproduces the dead boot on demand (a
      // view that has never been visible gets no grace). A second launch
      // shows it again, through the single-instance plugin above.
      #[cfg(all(desktop, debug_assertions))]
      if std::env::var("WHERRY_HIDE").ok().as_deref() == Some("1") {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
          window.hide()?;
          log::warn!("shell: window hidden at boot (WHERRY_HIDE=1)");
        }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Keeping the page scheduled (macOS)
// ---------------------------------------------------------------------------
//
// Measured 2026-09-07 (docs/prompts/native-media-plan.md §5.1, gate 2):
// WebKit on macOS 26 runs the WebContent process under RunningBoard and
// **suspends it** -- no timers, no JavaScript, nothing -- about eight
// seconds after the view stops being "visible", and a view whose window is
// fully behind another window is not visible. The only things that hold a
// foreground assertion are a visible view, audible playback from the page,
// or media capture in the page (WebPageProxy::updateThrottleState). The
// webview transport plays the call's audio *in the page*, which is why it
// never showed this; the native transport plays it in this process, so a
// call in an occluded window stopped re-keying, and a boot behind another
// window never placed its call at all.
//
// The mechanism is WKWebView's window-occlusion detection: with it off, an
// occluded window still counts as visible and the process keeps its
// foreground assertion. It is a private property (`WKWebViewPrivate.h`),
// reached by Key-Value Coding so nothing links against it, and it decides
// nothing here: TypeScript says when the page must stay scheduled
// (`voice/` while a call is up, or the sync engine for the shell's whole
// life -- that is the decision, and it is not this file's). A minimized
// window is still not visible: `windowDidMiniaturize` is a separate signal
// this switch does not touch.

/// Turn WKWebView's window-occlusion detection on or off for a window.
#[cfg(target_os = "macos")]
fn set_window_occlusion_detection(window: &tauri::WebviewWindow, enabled: bool) -> tauri::Result<()> {
  window.with_webview(move |platform| {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNumber, NSString};
    let webview = platform.inner() as *mut AnyObject;
    if webview.is_null() {
      log::warn!("shell: no WKWebView to set occlusion detection on");
      return;
    }
    let value = NSNumber::numberWithBool(enabled);
    let key = NSString::from_str("windowOcclusionDetectionEnabled");
    // KVC finds the `_setWindowOcclusionDetectionEnabled:` setter for this
    // key by its own search rule (`set<Key>:`, then `_set<Key>:`).
    unsafe {
      let _: () = msg_send![webview, setValue: &*value, forKey: &*key];
    }
    log::info!(
      "shell: window occlusion detection {}",
      if enabled { "on (an occluded window is hidden)" } else { "off (an occluded window stays visible)" }
    );
  })
}

/// The page asks to stay scheduled while its window is occluded (`true`) or
/// to be treated like any other hidden view again (`false`). A no-op off
/// macOS: Windows and Linux do not suspend a hidden webview's process.
#[tauri::command]
#[allow(unused_variables)]
fn shell_keep_page_visible(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    use tauri::Manager;
    // Debug builds: `WHERRY_KEEP_AWAKE=0` refuses the request, so a control run
    // can watch WebKit suspend the page with the client unchanged.
    #[cfg(debug_assertions)]
    if std::env::var("WHERRY_KEEP_AWAKE").ok().as_deref() == Some("0") {
      log::warn!("shell: keep-page-visible request ignored (WHERRY_KEEP_AWAKE=0)");
      return Ok(());
    }
    let Some(window) = app
      .get_webview_window("main")
      .or_else(|| app.webview_windows().into_values().next())
    else {
      return Err("no window".to_string());
    };
    set_window_occlusion_detection(&window, !enabled).map_err(|e| e.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    Ok(())
  }
}
