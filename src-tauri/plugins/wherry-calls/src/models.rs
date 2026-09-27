// The command arguments and answers, mirroring `client/src/voice/
// phone-calls.ts` field for field (camelCase on the wire). They are shapes,
// not decisions: every value is passed to the native plugin as given, and
// what the page may send is decided in phone-rules.ts.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// "page", "notification" or "callkit". A string rather than an enum so
    /// a newer native side cannot fail an older page's deserialisation; the
    /// page reads it defensively (`readCapabilities`).
    pub ring_ui: String,
    #[serde(default)]
    pub call_service: bool,
    #[serde(default)]
    pub voip: bool,
}

impl Capabilities {
    /// What a build without native call pieces can do: the page rings.
    pub fn page_only() -> Self {
        Self {
            ring_ui: "page".into(),
            call_service: false,
            voip: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureArgs {
    pub api_base: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelsArgs {
    /// Conversation id to display name; names only, never content.
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushToken {
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingArgs {
    pub call_id: String,
    pub conversation_id: String,
    pub label: String,
    pub group: bool,
    /// Seconds since the epoch, the push payload's unit.
    pub exp: i64,
}

/// What `report_incoming` answers: whether the native side took the ring
/// (`IncomingAnswer` in phone-calls.ts). A missing field reads as false, so
/// the page's sheet rings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingAnswer {
    #[serde(default)]
    pub shown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveArgs {
    pub active: bool,
    pub call_id: Option<String>,
    pub label: Option<String>,
    pub audio_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedArgs {
    pub call_id: String,
    /// `PhoneEndReason` in phone-calls.ts, whose table says what each reason
    /// does natively. `answered` ends no call.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingArgs {
    pub call_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// "answer", "decline" or "hangup".
    pub kind: String,
    pub call_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Milliseconds since the epoch, when the press happened.
    #[serde(default)]
    pub at: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingActions {
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugIncomingArgs {
    /// A push payload as APNs or FCM would deliver it (plan §4.2), handed
    /// to the same native handler. Debug builds only.
    pub payload: serde_json::Value,
}
