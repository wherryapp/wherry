// The commands the page invokes as `plugin:wherry-calls|<name>`. Each is a
// passthrough to the platform half (mobile.rs or desktop.rs); the argument
// names are the camelCase fields of phone-calls.ts, which Tauri maps to
// these snake_case parameters.

use std::collections::BTreeMap;

use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{Result, WherryCallsExt};

#[command]
pub(crate) async fn capabilities<R: Runtime>(app: AppHandle<R>) -> Result<Capabilities> {
    app.wherry_calls().capabilities()
}

#[command]
pub(crate) async fn configure<R: Runtime>(
    app: AppHandle<R>,
    api_base: String,
    device_id: String,
) -> Result<()> {
    app.wherry_calls().configure(ConfigureArgs {
        api_base,
        device_id,
    })
}

#[command]
pub(crate) async fn set_labels<R: Runtime>(
    app: AppHandle<R>,
    labels: BTreeMap<String, String>,
) -> Result<()> {
    app.wherry_calls().set_labels(LabelsArgs { labels })
}

#[command]
pub(crate) async fn push_token<R: Runtime>(app: AppHandle<R>) -> Result<PushToken> {
    app.wherry_calls().push_token()
}

#[command]
pub(crate) async fn report_incoming<R: Runtime>(
    app: AppHandle<R>,
    call_id: String,
    conversation_id: String,
    label: String,
    group: bool,
    exp: i64,
) -> Result<()> {
    app.wherry_calls().report_incoming(IncomingArgs {
        call_id,
        conversation_id,
        label,
        group,
        exp,
    })
}

#[command]
pub(crate) async fn set_active<R: Runtime>(
    app: AppHandle<R>,
    active: bool,
    call_id: Option<String>,
    label: Option<String>,
    audio_only: bool,
) -> Result<()> {
    app.wherry_calls().set_active(ActiveArgs {
        active,
        call_id,
        label,
        audio_only,
    })
}

#[command]
pub(crate) async fn report_ended<R: Runtime>(
    app: AppHandle<R>,
    call_id: String,
    reason: String,
) -> Result<()> {
    app.wherry_calls()
        .report_ended(EndedArgs { call_id, reason })
}

#[command]
pub(crate) async fn start_outgoing<R: Runtime>(
    app: AppHandle<R>,
    call_id: String,
    label: String,
) -> Result<()> {
    app.wherry_calls()
        .start_outgoing(OutgoingArgs { call_id, label })
}

#[command]
pub(crate) async fn take_pending_actions<R: Runtime>(app: AppHandle<R>) -> Result<PendingActions> {
    app.wherry_calls().take_pending_actions()
}

#[command]
pub(crate) async fn debug_incoming<R: Runtime>(
    app: AppHandle<R>,
    payload: serde_json::Value,
) -> Result<()> {
    app.wherry_calls()
        .debug_incoming(DebugIncomingArgs { payload })
}
