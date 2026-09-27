// The bridge to the native plugin: `CallsPlugin` in Kotlin
// (android/src/main/java/app/wherry/calls/) and Swift (ios/Sources/
// WherryCalls/). Each method is one `run_mobile_plugin` with the command's
// camelCase name; nothing is decided here.

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.wherry.calls";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_wherry_calls);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<WherryCalls<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CallsPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_wherry_calls)?;
    Ok(WherryCalls(handle))
}

/// Access to the native call pieces.
pub struct WherryCalls<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> WherryCalls<R> {
    pub fn capabilities(&self) -> crate::Result<Capabilities> {
        Ok(self.0.run_mobile_plugin("capabilities", ())?)
    }

    pub fn configure(&self, args: ConfigureArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("configure", args)?)
    }

    pub fn set_labels(&self, args: LabelsArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("setLabels", args)?)
    }

    pub fn push_token(&self) -> crate::Result<PushToken> {
        Ok(self.0.run_mobile_plugin("pushToken", ())?)
    }

    pub fn report_incoming(&self, args: IncomingArgs) -> crate::Result<IncomingAnswer> {
        Ok(self.0.run_mobile_plugin("reportIncoming", args)?)
    }

    pub fn set_active(&self, args: ActiveArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("setActive", args)?)
    }

    pub fn report_ended(&self, args: EndedArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("reportEnded", args)?)
    }

    pub fn start_outgoing(&self, args: OutgoingArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("startOutgoing", args)?)
    }

    pub fn take_pending_actions(&self) -> crate::Result<PendingActions> {
        Ok(self.0.run_mobile_plugin("takePendingActions", ())?)
    }

    pub fn reset_account(&self) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("resetAccount", ())?)
    }

    pub fn debug_incoming(&self, args: DebugIncomingArgs) -> crate::Result<()> {
        Ok(self.0.run_mobile_plugin("debugIncoming", args)?)
    }
}
