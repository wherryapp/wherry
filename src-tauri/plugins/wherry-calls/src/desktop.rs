// The desktop side answers every command inertly, so the crate compiles
// and behaves on any target. The app never builds it for desktop -- it is a
// mobile-table dependency -- and the page never asks there either
// (phone-calls.ts finds no plugin in the desktop shell), so this exists for
// `cargo check` and for honesty about what a desktop call would get.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<WherryCalls<R>> {
    Ok(WherryCalls(app.clone()))
}

/// Access to the native call pieces: none on a desktop.
pub struct WherryCalls<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> WherryCalls<R> {
    pub fn capabilities(&self) -> crate::Result<Capabilities> {
        Ok(Capabilities::page_only())
    }

    pub fn configure(&self, _args: ConfigureArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn set_labels(&self, _args: LabelsArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn push_token(&self) -> crate::Result<PushToken> {
        Ok(PushToken::default())
    }

    pub fn report_incoming(&self, _args: IncomingArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn set_active(&self, _args: ActiveArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn report_ended(&self, _args: EndedArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn start_outgoing(&self, _args: OutgoingArgs) -> crate::Result<()> {
        Ok(())
    }

    pub fn take_pending_actions(&self) -> crate::Result<PendingActions> {
        Ok(PendingActions::default())
    }

    pub fn debug_incoming(&self, _args: DebugIncomingArgs) -> crate::Result<()> {
        Ok(())
    }
}
