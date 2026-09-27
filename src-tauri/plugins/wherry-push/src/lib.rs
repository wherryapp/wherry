//! Native push for the phone shells: APNs on iOS, FCM on Android.
//!
//! Mechanism only, behind the interface `client/src/sync/native-push.ts`
//! names (CLAUDE.md, `src-tauri/`: decisions in TypeScript, mechanism in
//! Rust). There is no Rust logic here: the commands in
//! docs/prompts/native-push-plan.md §5.1 are implemented by the Swift
//! (`ios/Sources/PushPlugin.swift`) and Kotlin (`android/`) halves, and this
//! file only registers them with Tauri.
//!
//! The app depends on this crate only in its mobile table, so it is never
//! compiled for a desktop target.

use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_wherry_push);

#[cfg(target_os = "android")]
const ANDROID_PACKAGE: &str = "app.wherry.push";

/// Registers the plugin. **Order matters on iOS**: register it after
/// `tauri_plugin_notification::init()`, because the Swift half wraps the
/// `UNUserNotificationCenter` delegate that plugin installs when it loads
/// (plan §5.2, mechanism 2). Tauri initialises plugins in registration order.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("wherry-push")
    .setup(|_app, api| {
      #[cfg(target_os = "ios")]
      api.register_ios_plugin(init_plugin_wherry_push)?;
      #[cfg(target_os = "android")]
      api.register_android_plugin(ANDROID_PACKAGE, "PushPlugin")?;
      #[cfg(not(any(target_os = "ios", target_os = "android")))]
      let _ = api;
      Ok(())
    })
    .build()
}
