//! `wherry-calls`: the phones' native call pieces behind the page's
//! `PhoneCalls` interface (client/src/voice/phone-calls.ts;
//! docs/prompts/phone-calls-plan.md §5).
//!
//! The shell's rule holds here as in the app crate: decisions in
//! TypeScript, mechanism in native code, and the boundary a named
//! interface. This crate is only the registration and the passthrough; the
//! mechanism is the Kotlin (`android/`) and Swift (`ios/`) plugin.
//!
//! Registered in the app by one `.plugin(tauri_plugin_wherry_calls::init())`
//! line inside the push plugin's `#[cfg(mobile)]` block of
//! `client/src-tauri/src/lib.rs` (coordination §2).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
use desktop::WherryCalls;
#[cfg(mobile)]
use mobile::WherryCalls;

/// Access to the plugin from Rust, for completeness; the app's own Rust
/// never calls it (the page does, through the commands).
pub trait WherryCallsExt<R: Runtime> {
    fn wherry_calls(&self) -> &WherryCalls<R>;
}

impl<R: Runtime, T: Manager<R>> WherryCallsExt<R> for T {
    fn wherry_calls(&self) -> &WherryCalls<R> {
        self.state::<WherryCalls<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wherry-calls")
        .invoke_handler(tauri::generate_handler![
            commands::capabilities,
            commands::configure,
            commands::set_labels,
            commands::push_token,
            commands::report_incoming,
            commands::set_active,
            commands::report_ended,
            commands::start_outgoing,
            commands::take_pending_actions,
            commands::reset_account,
            commands::debug_incoming,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let calls = mobile::init(app, api)?;
            #[cfg(desktop)]
            let calls = desktop::init(app, api)?;
            app.manage(calls);
            Ok(())
        })
        .build()
}
