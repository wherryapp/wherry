# Stage 3 patches — `0001-PlatformAudio-…` and `0002-libwebrtc-…`

Two more commits on `wherryapp/rust-sdks`, on top of the frame-cryptor
detach (`73ff28ce`, see `rust-sdks-frame-cryptor-detach.md`), written
2026-09-08 for stage 3 of `docs/prompts/native-media-plan.md`. Both are the
upstream-shaped fix for something the SDK's public API promised and did
not do; both are meant to be sent upstream as their own pull requests, in
this order, once the maintainer has signed LiveKit's CLA for #1408.

## 0001 — `PlatformAudio::configure_audio_processing` does something on desktop

**What was wrong.** The method only ever touched the *hardware* effects
(`enable_builtin_aec` and friends). Desktop has none, so on macOS, Windows
and Linux the three booleans were accepted, logged
(`Audio processing configured: AEC=false …`) and ignored; WebRTC's software
APM kept the defaults WebRtcVoiceEngine applies at its own init (echo
cancellation, noise suppression and gain control all on).

**Two things set the APM's config, and the fix needs both — libwebrtc's own
log decided it.** With `WHERRY_WEBRTC_LOG=1` (a debug knob the shell gained
for this) the SDK's forwarded libwebrtc log shows every
`WebRtcVoiceEngine::ApplyOptions` and `AudioProcessing::ApplyConfig`, and
three runs on 2026-09-08 read as follows:

1. `WebRtcVoiceEngine::Init` applies `AudioOptions {aec: 1, agc: 1, ns: 1,
   hf: 1}` once, **lazily, when the first PeerConnection is created** — so a
   switch set before the first connect was undone a few milliseconds later.
   The bridge's `PeerConnectionFactory` now builds the module itself
   (`BuiltinAudioProcessingBuilder().Build(env)` handed to the factory
   through `CustomAudioProcessing`), `set_audio_processing(aec, ns, agc)`
   edits the three `enabled` flags on its live config (so the high-pass
   filter and the analog gain controller's tuning survive), and the
   factory remembers the switches and re-applies them after every
   PeerConnection is initialised. Every later options pass starts from the
   APM's live config, so the re-applied value holds — until:
2. `AudioRtpSender::SetSend` hands the audio *source's* `AudioOptions` to
   the engine every time a track is sent — publish, unmute — and
   `create_device_audio_track` hard-coded those to all-on, so the moment the
   microphone published, `ApplyOptions {aec: 1, agc: 1, ns: 1}` ran again
   and the canceller came back. The device track now takes its
   `AudioSourceOptions` and `LocalAudioTrack` passes the switches
   `PlatformAudio` was last configured with.

(An earlier attempt carried only the second half and read as "the source
options never reach the APM" — they do, at publish, which is exactly when
the first half alone was being undone. Both are needed.)

**What the commit changes.** `webrtc-sys`: the APM handle, the remembered
switches, `set_audio_processing` on the factory bridge. `libwebrtc`:
`PeerConnectionFactoryExt::set_audio_processing(AudioSourceOptions)`, and
`AudioSourceOptions` gains `Clone, Copy, PartialEq, Eq`. `livekit`:
`LkRuntime` keeps the switches, `configure_audio_processing` and the three
`set_*` conveniences apply them, and `active_*_type()` answers `None` for a
stage that is off instead of `Software` unconditionally.

## 0002 — a remote audio track's playout volume

**What was missing.** `AudioTrackInterface::SetVolume(double)` exists in
libwebrtc (for a remote track it reaches `RemoteAudioSource` and, through
`AudioRtpReceiver`, the receive stream's gain — what a browser applies with
`HTMLMediaElement.volume`), but the bridge exposed nothing, so a consumer
playing through the platform ADM could only enable or disable a track.

**The commit.** `webrtc-sys`: `AudioTrack::set_volume(double)`, hopping to
the signaling thread with a `BlockingCall` because `AudioRtpReceiver`
expects it. `libwebrtc`: `RtcAudioTrack::set_volume(f64)`. WebRTC's range,
0.0 to 10.0 with 1.0 as unity.

**Verified 2026-09-08** on the dev Mac against a browser peer: with the
shell's listener volume for the peer set to 0.25 twenty-five seconds into a
call, the peer's *decoded* energy rate (inbound-rtp `totalAudioEnergy`
delta per 3 s sample) fell from about 0.125 to about 0.0105 — the gain is
applied at the receive stream, before the statistics are taken — and
`0.25² = 0.0625` is the expected ratio; the measured 0.065–0.084 is
consistent with that and a little residual from the transition sample.

## Carrying them

Cargo cannot apply a patch file to a git dependency, so the build takes
these the way it takes the detach fix: from the fork. The branch carrying
all three commits is `wherry/stage-3`, pushed 2026-09-08 at
`9566238baccf6b0b559be05d70d3106e941cb761`; `client/src-tauri/Cargo.toml`'s
`livekit` dependency points at it (all three crates change, so a `[patch]`
on `webrtc-sys` alone was no longer enough) and `LIVEKIT_REV` in
`src/voice.rs` names it. When upstream merges them, point back at
`livekit/rust-sdks` and bump `rev`.

To reproduce the build locally without the fork pushed:

```bash
git clone https://github.com/livekit/rust-sdks /Volumes/Scratch/rust-sdks
git -C /Volumes/Scratch/rust-sdks checkout dee418bba599fd505fa548ac6b9ab3379fc548fc
git -C /Volumes/Scratch/rust-sdks am client/src-tauri/patches/rust-sdks-frame-cryptor-detach.patch
git -C /Volumes/Scratch/rust-sdks am client/src-tauri/patches/0001-*.patch client/src-tauri/patches/0002-*.patch
# then, temporarily, in client/src-tauri/Cargo.toml:
# [patch."https://github.com/livekit/rust-sdks"]
# livekit   = { path = "/Volumes/Scratch/rust-sdks/livekit" }
# libwebrtc = { path = "/Volumes/Scratch/rust-sdks/libwebrtc" }
# webrtc-sys = { path = "/Volumes/Scratch/rust-sdks/webrtc-sys" }
```

(A clone holding unpushed commits is not regenerable and does not belong on
the scratch disk for long — push it, or keep it under the home directory.)

## Amended 2026-09-08 (evening): a fourth commit, on `wherry/stage-3n`

`e75845b1f0efc311d64c9570737c4f404d072c33` (branch `wherry/stage-3n`,
on top of `wherry/stage-3`) — `rust-sdks-frame-cryptor-detach-video.patch`:
the detach must not hand a *video* receiver a null transformer (it
segfaults in libwebrtc). `Cargo.toml` points at it; `LIVEKIT_REV` names
it. The clone that produced it was `/Volumes/Scratch/rust-sdks-fork`,
pushed the same minute.
