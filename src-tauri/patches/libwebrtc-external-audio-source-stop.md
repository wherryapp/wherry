# A stopped pushed-audio send stream is registered for microphone frames (row S-18)

**Not a patch we carry.** The defect is in LiveKit's own libwebrtc patch,
`webrtc-sys/libwebrtc/patches/external_audio_source.patch` in
`livekit/rust-sdks`. It is compiled into the prebuilt libwebrtc that
`webrtc-sys-build` downloads, `webrtc-89d790b` at our pinned `6a32ecc`, for
Windows, macOS and Linux alike. A fix to that patch in our fork would change
nothing in our binary until libwebrtc was rebuilt, so the shell works around
it instead. This file is the evidence, and the upstream report ready to file.

## What the patch does wrong

The patch keeps a pushed audio source (a `NativeAudioSource`) out of
`AudioState`'s microphone distribution: `AudioSendStream::Start()` skips
`AddSendingStream` when `config_.external_source` is set, and `Stop()` skips
`RemoveSendingStream` to match. Two things go wrong on the way:

1. **`Stop()` no longer clears `sending_`.** Upstream's `Stop()` ends with
   `sending_ = false;` followed by `audio_state()->RemoveSendingStream(this);`.
   The patch deletes both lines and adds back only the guarded call, so every
   stream stopped under this patch still reads as sending.
2. **The other registration site is unguarded.** `StoreEncoderProperties`,
   called when the send codec is set up, does
   `if (sending_) audio_state()->AddSendingStream(this, ...)` with no
   `external_source` check.

Together: a pushed-source stream that is stopped and then has its send codec
set up again is registered with `AudioState` as a microphone recipient. That
is what a mid-call unpublish does, since the renegotiation that follows
reconfigures the stream. **Which codec parameter changes in that
renegotiation has not been read.** `Stop()` will never remove that
registration, and the stream is freed with the peer connection. `AudioState`
belongs to the process-wide factory, so the next call's first microphone frame
goes through `AudioTransportImpl::SendProcessedData` to a freed `AudioSender`.

## Evidence, 2026-09-15, on the Windows rig

- **The crash.** `wherry-desktop.exe+0x1a1579b` (`0xc0000005`) resolves
  through the build's PDB to `webrtc::AudioTransportImpl::SendProcessedData +
  0x13b`: the vtable read on the first entry of `audio_senders_`. There is no
  symbolizer on the dev Mac or the guest, so the lookup read the PDB's MSF
  publics stream directly. The next public symbol starts 0x105 past the fault.
- **The trigger, bisected on a fresh process each time.** Share a screen with
  audio, stop the share mid-call, hang up, call again: the shell dies one to
  three seconds in, as the microphone starts, three times out of three. None
  of these crash: two plain calls; a share without audio stopped mid-call; an
  audio share still on at hang-up.
- **The binary agrees with the patch text.** Disassembly of the shipped
  build, with each function found through the PDB publics:
  - `AudioSendStream::Start` (`0x14178fd90`) returns early when the byte at
    `+0x280` is set, writes `1` there, and calls `AddSendingStream` only when
    `+0x258` is zero. That is `sending_` and `config_.external_source`.
  - `AudioSendStream::Stop` (`0x141790070`) calls `RemoveSendingStream` only
    when `+0x258` is zero, and **never writes `+0x280`**.
  - `AudioSendStream::SetupSendCodec` (`0x141790f80`), with
    `StoreEncoderProperties` inlined, stores the encoder's rate and channels
    and then runs `cmpb $0x1, 0x280(%rbx); jne; call AddSendingStream`.
    **There is no `+0x258` test.**
- **A live share does not leak.** While a native share was on, an analyser
  on the peer read none of the microphone's tone on the share's track. That
  fits a stream that is never registered unless a codec setup reaches it
  after `Start()`.

## What the shell does instead

`video.rs`'s `ScreenAudioPublication`: a share's sound is published once per
call. When a share stops, the publication is **muted and kept**, with its
capture stopped. The next share with sound unmutes it into the same source
with a fresh capture. The room's close unpublishes it at hang-up, which is
the case that does not crash. Muting never stops the stream, so `sending_`
never goes stale.

**Anything else that unpublishes a pushed audio track mid-call reopens this.**

## Upstream issue — drafted, not filed

**Title:** external_audio_source.patch: a stopped external `AudioSendStream`
keeps `sending_` and is re-registered with `AudioState`, leaving a dangling
`AudioSender`

`external_audio_source.patch` changes `AudioSendStream::Stop()` from

```cpp
  channel_send_->StopSend();
  sending_ = false;
  audio_state()->RemoveSendingStream(this);
```

to

```cpp
  channel_send_->StopSend();
  if (!config_.external_source) {
    audio_state()->RemoveSendingStream(this);
  }
```

which drops `sending_ = false;` for every stream. `StoreEncoderProperties`
still registers any stream whose `sending_` is set:

```cpp
  if (sending_) {
    audio_state()->AddSendingStream(this, sample_rate_hz, num_channels);
  }
```

So an external-source stream that is stopped and then has its send codec set
up again — an unpublish mid-call, then renegotiation — is added to
`AudioState::sending_streams_`. Its `Stop()` will never remove it, and it is
destroyed with the peer connection. With a platform ADM recording, the next
`AudioTransportImpl::SendProcessedData` calls `SendAudioData` on the freed
stream.

**Reproduction:** on Windows (prebuilt `webrtc-89d790b`, `PlatformAudio`
recording), connect, publish a `NativeAudioSource` track beside the
microphone, unpublish it, disconnect, connect again. Access violation in
`AudioTransportImpl::SendProcessedData` within a second of recording
starting.

**Suggested fix:**

```diff
   channel_send_->StopSend();
+  sending_ = false;
   if (!config_.external_source) {
     audio_state()->RemoveSendingStream(this);
   }
```

and in `StoreEncoderProperties`, `if (sending_ && !config_.external_source)`.
