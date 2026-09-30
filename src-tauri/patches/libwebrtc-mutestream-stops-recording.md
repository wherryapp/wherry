# Muting one audio track starts or stops the whole device's recording (rows D-68, D-69)

**Not a patch we carry.** The behaviour is in the libwebrtc that
`webrtc-sys-build` downloads prebuilt (`webrtc-89d790b`, webrtc-sdk's
`m150_release`, at our pinned `06f0a5d`, the same `WEBRTC_TAG` as at
`6a32ecc`, where this was found), not in any patch LiveKit or we
apply. A change in our fork would do nothing until libwebrtc was rebuilt, so
the shell works around it (`client/src-tauri/src/voice/mod.rs`, above
`set_microphone_gate`). This file is the evidence and the upstream report,
ready to file.

## What the code does

`WebRtcVoiceSendChannel::MuteStream` (`media/engine/webrtc_voice_engine.cc`)
runs on every enable or disable of a local audio track
(`AudioRtpSender::OnChanged` → `SetSend` → `SetAudioSend` → `MuteStream`). In
webrtc-sdk's tree it ends with a block upstream WebRTC does not have:

```cpp
bool is_all_muted =
    std::all_of(send_streams_.begin(), send_streams_.end(),
                [](const auto& kv) { return kv.second->IsMuted(); });
...
if (!is_all_no_source) {
  webrtc::AudioDeviceModule* adm = engine()->adm();
  if (adm) {
    if (adm->IsStopOnMuteModeEnabled()) {
      if (!is_all_muted && !adm->Recording()) {
        if (adm->InitRecording() == 0) {
          adm->StartRecording();
        }
      } else if (is_all_muted && adm->Recording()) {
        adm->StopRecording();
      }
    } else {
      adm->SetMicrophoneMute(is_all_muted);
    }
  }
}
```

Two properties of that block cause the defects:

1. **`send_streams_` is one channel's, and there is one channel per
   transceiver.** Under unified plan `RtpTransceiver` creates its own send
   channel (`CreateMediaContentChannels` in `pc/rtp_transceiver.cc`). A
   participant publishing a microphone and a second audio track has two
   channels with one stream each. Each channel sees its own stream as all the
   streams there are, but the module it starts and stops is the process-wide
   one.
2. **An external source is counted as if it read the device.** A
   `NativeAudioSource` track, which LiveKit's `external_audio_source.patch`
   deliberately keeps out of `AudioState`'s microphone distribution, still
   starts and stops the device's recording through this block.
   `IsStopOnMuteModeEnabled()` is the interface default (`true`), and the
   SDK's `AdmProxy` does not override it.

## What it does to a call

Read on the Windows rig on 2026-09-26, on the released `752e36d` and on a fix
build, with `WHERRY_WEBRTC_LOG=1`:

- **Muting the second track stops the microphone (D-68).** The shell keeps a
  share's sound published and mutes it when the share stops. It cannot
  unpublish mid-call, because of `libwebrtc-external-audio-source-stop.md`
  (row S-18). The mute is that channel's last stream, so the module stops
  recording inside the mute (`total recording time:` the whole call). The
  unmuted microphone then reaches the far end as digital silence (−140 dB)
  for the rest of the call.
- **Unmuting it while the microphone is muted opens the microphone (D-69).**
  Publishing or unmuting the second track makes its channel not-all-muted
  while the module is not recording. libwebrtc then runs `InitRecording` and
  `StartRecording`, capturing a microphone its user muted. On Windows, a
  renegotiation while muted can have had `EnableBuiltInAEC(1)` accepted, and
  then that `InitRecording` goes through the voice-capture DMO at 16 kHz
  (`Capture device index: 0, render device index: 0`,
  `SetRecordingSampleRate(16000)`).

**What the log shows.** The fix build's run of 2026-09-27 (`0812575`, three
shares with audio in one process, microphone unmuted) logged this at every
*Stop sharing*, in this order:

```
AudioRtpSender::OnChanged reapplying send state, enabled_changed=1, options_changed=0
WebRtcVoiceSendChannel::MuteStream: APM:1
WebRtcVoiceSendChannel::MuteStream: ADM:1
virtual webrtc::AudioDeviceModuleImpl::Recording
virtual webrtc::AudioDeviceModuleImpl::StopRecording
total recording time: 14155
voice: screen audio muted after 451 frame(s), kept published      <- the shell's line
```

`ADM:` prints `is_all_muted`, so the channel judged itself all-muted while
the microphone was unmuted. The shell's line comes last because the shell logs
it after the capture thread has stopped; the stop itself happened inside the
mute. A share started with the microphone muted logged `MuteStream: ADM:0`,
`InitRecording`, `Capture device index: 0, render device index: 0`,
`SetRecordingSampleRate(16000)` and `StartRecording`. Those came after the
shell's `screen published … with audio`, during a later publisher offer. A
new sender's send state is applied at `SetLocalDescription` (`SetSsrc` →
`SetSend`), not when the track is added.

**Status of these claims.** The two failures are verified on the rig, and so
is the order above. That the cause is one channel's `send_streams_` is
**believed**: it follows from the source at `89d790b` and from `ADM:1`
being logged under an unmuted microphone. The log does not print which streams
a channel holds, and no one has stepped through it.

## What the shell does instead

- **The gate.** `AdmProxy::set_recording_enabled` makes every
  `InitRecording`/`StartRecording` that reaches the proxy a no-op returning
  success. The factory exposes it as `set_adm_recording_enabled`. The shell
  keeps it open only while the call's microphone is published and unmuted, so
  a start triggered from the share's channel opens nothing. Opening the gate
  again starts nothing by itself (`SwitchRecordingAdm` returns early unless
  the proxy was recording). The unmute therefore still runs the D-67 repair
  before its own `InitRecording`.
- **A restart.** The gate cannot refuse a stop while the microphone is open.
  Right after muting the share's sound, `ensure_microphone_recording` finds
  recording uninitialised and starts it again, with the repair in front. The
  microphone loses the milliseconds in between.
- **A second look after each renegotiation.** A (re)published sender's
  `MuteStream` arrives with the next offer, after the SDK call returns.
  `recheck_microphone` therefore checks at once and again after 1 s and 3 s.
  It runs after a share stops, after the share's sound is published or
  unmuted, and after `RoomEvent::Reconnected`. A full reconnect republishes
  every local track, including the parked, muted share's sound, and that
  republish is a mute on its own channel. The reconnect case is believed from
  the SDK's `handle_restarted` and has not been read.

## Upstream issue — drafted, not filed

**To:** `webrtc-sdk/webrtc`, where the block lives. Copy to
`livekit/rust-sdks`, because `external_audio_source.patch` is what makes a
second, non-device audio track an ordinary thing to publish.

**Title:** `MuteStream` starts/stops the ADM from one channel's view, so
muting an external-source track stops the microphone

`WebRtcVoiceSendChannel::MuteStream` decides `adm->StopRecording()` /
`InitRecording()+StartRecording()` from `is_all_muted` over its own
`send_streams_`. Under unified plan each audio transceiver has its own send
channel, so a second audio track — in LiveKit's case a `NativeAudioSource`
marked `external_source`, which never reads the device — stops the device's
recording when it is muted, even while the microphone track in another
transceiver is unmuted and sending. Unmuting it starts the device's recording
even while the microphone track is muted.

**Reproduction:** with a platform ADM, publish a device microphone track and a
`NativeAudioSource` track on one PeerConnection. Mute the second with
`set_enabled(false)`. On our Windows build (webrtc-sdk `89d790b` through
LiveKit's Rust SDK) the log then shows `MuteStream: ADM:1` and
`AudioDeviceModuleImpl::StopRecording`, both inside that call, while the
microphone track is still enabled. The microphone track then reaches the far
end as digital silence. We have not reproduced it outside the Rust SDK or on
another platform.

**Suggested fix, smallest first:**

1. In `MuteStream`, skip the ADM block when the stream being muted has an
   external source (`config_.external_source`), since muting it says nothing
   about the device.
2. Compute the decision in `AudioState`, over every sending stream that reads
   the device, across channels, instead of in each channel. For example, add
   an `OnMuteStreamChanged()` there that asks whether any stream in
   `sending_streams_` is unmuted. Those are exactly the streams the ADM
   feeds, because external ones are never added (except by the stale
   `sending_` in `libwebrtc-external-audio-source-stop.md`, which that fix
   closes).
