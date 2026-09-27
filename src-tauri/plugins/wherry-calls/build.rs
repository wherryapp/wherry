// The command set is plan §5.2's, fixed by stage PC1: a stage that needs
// another command asks the integrator, and the addition lands here as a
// PC1 follow-up (the plan's §9). `register_listener` and `remove_listener`
// are what `addPluginListener` invokes for the plugin's events (`action`,
// `push-token`, `mute`); Tauri's native plugin base classes implement them.
const COMMANDS: &[&str] = &[
    "capabilities",
    "configure",
    "set_labels",
    "push_token",
    "report_incoming",
    "set_active",
    "report_ended",
    "start_outgoing",
    "take_pending_actions",
    "debug_incoming",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
