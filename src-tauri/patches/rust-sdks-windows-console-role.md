# rust-sdks-windows-console-role.patch

One commit on `wherryapp/rust-sdks`, on top of `wherry/stage-3n` at
`e75845b` (the revision `Cargo.toml` pinned before it), written 2026-09-15 for
row S-16 in `docs/regression/desktop.md`: `webrtc-sys/src/adm_proxy.cpp` stops
handing libwebrtc's Windows audio module the **communications** role for "the
default device", and hands it the **console** role instead. **Pushed the same
day** as `wherry/windows-console-role` (commit `6a32ecc`, a new branch, so
`wherry/stage-3n` and #1408's `wherry/frame-cryptor-detach` are untouched);
`Cargo.toml`'s `rev` pins it and `LIVEKIT_REV` names it. Like the others it is
meant to go upstream as its own pull request once the CLA for #1408 is signed.

## What was wrong

On Windows 11 the native engine makes Windows lower every other application's
sound by 18 dB as soon as a call starts, and keeps it lowered until the shell
exits (Windows' *Communications* setting, "Reduce the volume of other sounds
by 80%", is on by default). The webview engine does not, and neither does a
browser.

**The trigger is a render stream opened through the `eCommunications` role,
and nothing else.** A C++ probe (`scripts/regress/win-ducking-probe`) opened
one shape of stream per run on the rig against a 440 Hz tone another process
was playing, measured at the host (`scripts/rig/host/tone-level.sh`):

| Shape | Tone during |
|---|---|
| render, communications role | **−23.0 dBFS** |
| capture, communications role | −5.0 |
| render or capture, console role | −5.0 |
| both, communications role | **−23.0** |
| both, console role | −5.0 |
| both, a device chosen by index (no role) | −5.0 |
| capture, communications role, category *Other* | −5.0 |
| both on communications, capture released halfway | **−23.0** until render closed |
| a session reached through the communications role, then render by index | −5.0 |

**libwebrtc asks for that role by default, twice.** `AudioDeviceWindowsCore`
initialises `_outputDevice` and `_inputDevice` to
`kDefaultCommunicationDevice`, which `InitSpeakerLocked` turns into
`GetDefaultAudioEndpoint(eRender, eCommunications)`. And
`WebRtcVoiceEngine::Init` calls `adm_helpers::Init`, which selects
`kDefaultCommunicationDevice` for both — lazily, when the first PeerConnection
is created (`rust-sdks-stage-3.md`, point 1), so **after** the shell's
`voice_connect` has chosen a device. That is why choosing both devices
explicitly by id in the shell still ducked: the choice was replaced on the
first call. Chromium's own default is the console role.

**Why it outlives the call.** libwebrtc keeps playout running after a call and
the shell holds `PlatformAudio` for the life of the process, so the
communications render stream never closes; the rig's session list showed
`wherry-desktop.exe`'s render session still ACTIVE after hanging up while its
capture session had gone inactive.

## The change

A `ConsoleRole` helper maps `kDefaultCommunicationDevice` to `kDefaultDevice`
on Windows (`_WIN32`), applied in both `WindowsDeviceType` setters — the path
`adm_helpers::Init` and anything else choosing "the default" takes — and in
`EnsurePlatformAdmCreated`, which now selects the console default outright
when nothing was selected before the module existed, because
`AudioDeviceWindowsCore`'s own starting value is the communications role. A
device chosen by index is never touched. Nothing changes on macOS, Linux,
iOS or Android: the helper returns its argument there and the two `else`
branches are not compiled.

**The trade-off, stated.** Capture is mapped as well as render, although a
capture stream alone ducks nothing: the defaults have to stay a pair. Somebody
whose headset is Windows' default *communications* device and whose speakers
are the default *device* now gets the call on the speakers and microphone
pair. That is believed to be what the webview engine already opens — it is
Chromium, whose "default" device is the console default, and on the rig it
does not duck — but which role WebView2 opens was not observed directly, and
no other application's behaviour was checked. Choosing the headset in
Settings → Voice is the way to use it either way.

## Verification

**Verified on the rig, 2026-09-15** (Windows 11 Pro 26200, WARP). The patched
file went over the guest's cargo checkout of `e75845b` — byte-identical to the
fork original beforehand, SHA-256 `91e2a03a…`, and `ef800137…` after — with
`webrtc-sys`'s fingerprints cleared so cargo recompiled the bridge, and the
`--debug` bundle rebuilt and installed. The checkout was put back to the
original afterwards. Against the same instrument, a 440 Hz tone another process
plays, with a baseline of −5.0 dBFS:

- **a lone native call, ringing: −5.0 during and −5.0 after** — against −23.0
  and −23.0 before the change;
- **an answered native call with the Edge peer: −6.1 during, −5.0 after**, the
  shell's stats reading the peer received and playing (`bytesReceived` 44,048,
  `audioEnergy` 3.2) and its own packets sent, the peer reading the shell
  encrypted;
- **with the tone stopped**, the guest's output went from silence to −21.8 dBFS
  broadband during the answered call and back to silence after: the call's
  audio still reaches the device, through the console-role stream.

**Off Windows:** the pushed commit **compiles on macOS** — `cargo check` on the
dev Mac built `webrtc-sys`, bridge included, from `6a32ecc`. That behaviour
there is unchanged is believed rather than measured (the helper returns its
argument and the new branches are `_WIN32` only); Linux and the phones were not
built.

**Not addressed:** libwebrtc still keeps playout open after a call, so the shell
holds the output device for the life of the process. On the console role that
no longer ducks anything, but it is a stream nobody needs.
