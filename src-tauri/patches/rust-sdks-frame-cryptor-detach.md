# rust-sdks-frame-cryptor-detach.patch

One commit on top of `livekit/rust-sdks` at `dee418bb` (the revision
`Cargo.toml` pins): `FrameCryptor::~FrameCryptor` in
`webrtc-sys/src/frame_cryptor.cpp` detaches the transformer from the
`RtpSender`/`RtpReceiver` it was attached to. Without it every cryptor
leaves its `FrameCryptorTransformer` thread behind until the peer
connection is destroyed — one thread per cryptor per call, never
reclaimed (`docs/prompts/native-media-plan.md` §5.1, gate 1).

**Verified 2026-09-07** on the dev Mac against a browser peer: 20 leaked
threads after 10 calls on the unpatched bridge; 0 after 6 calls with the
patch, twice, with the audio still sealed both ways.

**In the build since 2026-09-07 (evening)** through the fork:
`wherryapp/rust-sdks`, branch `wherry/frame-cryptor-detach`, commit
`73ff28ce949cd1122c0e13d8376acfd8368fa2f4` — first through a `[patch]`
section in `client/src-tauri/Cargo.toml`, and since 2026-09-08 because the
`livekit` dependency itself points at the fork (`wherry/stage-3` at
`9566238b`, this commit plus stage 3's two — `rust-sdks-stage-3.md`).
**The upstream pull request is open:
[livekit/rust-sdks#1408](https://github.com/livekit/rust-sdks/pull/1408)**
(opened by the maintainer on 2026-09-07 with the command below; a session
cannot open one itself):

```bash
gh pr create --repo livekit/rust-sdks --base main \
  --head wherryapp:wherry/frame-cryptor-detach \
  --title "webrtc-sys: detach the frame transformer when a FrameCryptor is destroyed" \
  --body-file client/src-tauri/patches/rust-sdks-frame-cryptor-detach.md
```

(the body below the rule is written to be that PR's description). When it
merges — with the two beside it — point `livekit` back at
`livekit/rust-sdks` and bump `rev` with `LIVEKIT_REV`.

Cargo cannot apply a patch file to a git dependency, so the choices were:

- fork `livekit/rust-sdks` (under the `wherryapp` org), `git am` this
  file on a branch from `dee418bb`, and add to `client/src-tauri/Cargo.toml`:

  ```toml
  [patch."https://github.com/livekit/rust-sdks"]
  webrtc-sys = { git = "https://github.com/wherryapp/rust-sdks", rev = "<that commit>" }
  ```

  (only `webrtc-sys` is patched; `livekit` itself keeps coming from
  upstream at the pinned rev, and `webrtc-sys-build` follows the patched
  crate's workspace), or
- get the change merged upstream and bump `rev` in `Cargo.toml` together
  with `LIVEKIT_REV` in `src/voice.rs`.

To reproduce the measurement build locally without a fork:

```bash
git clone https://github.com/livekit/rust-sdks /tmp/rust-sdks
git -C /tmp/rust-sdks checkout dee418bba599fd505fa548ac6b9ab3379fc548fc
git -C /tmp/rust-sdks am /path/to/rust-sdks-frame-cryptor-detach.patch
# then, temporarily, in client/src-tauri/Cargo.toml:
# [patch."https://github.com/livekit/rust-sdks"]
# webrtc-sys = { path = "/tmp/rust-sdks/webrtc-sys" }
```

## Upstream issue — drafted, not filed

**Title:** webrtc-sys: FrameCryptor never detaches its transformer, leaking one FrameCryptorTransformer thread per cryptor per room

`FrameCryptor`'s constructors (`webrtc-sys/src/frame_cryptor.cpp`) attach a
`FrameCryptorTransformer` to the `RtpSender` / `RtpReceiver` with
`SetEncoderToPacketizerFrameTransformer` / `SetDepacketizerToDecoderFrameTransformer`.
`FrameCryptor::~FrameCryptor` only unregisters the observer; it never clears
the transformer on the sender/receiver, and the bindings expose no way for
the Rust side to. libwebrtc keeps a transformer for as long as it is set on
the sender/receiver, and the transformer owns a thread that stops only in
its destructor, so the thread outlives the `FrameCryptor`, the `Room` and
every handle the application holds.

Reproduction (macOS 15, Apple Silicon, `rev = dee418bb`, `livekit` with
`rustls-tls-native-roots`, E2EE `Gcm` with `KeyDerivationAlgorithm::HKDF`):

1. `Room::connect` with `E2eeOptions`, publish one microphone audio track
   (`PlatformAudio`), subscribe to one remote audio track.
2. `unpublish_track`, `Room::close`, drop the `Room`.
3. Repeat N times, then `sample <pid> 1 | grep -c FrameCryptorTransformer`.

Observed: the count grows by one per cryptor per call and never comes
back — 20 `FrameCryptorTransformer` threads after 10 calls that each had a
sender and a receiver cryptor. `E2eeManager::cleanup` does run on close
(it disables the cryptors and clears the map, so the Rust `FrameCryptor`
is dropped), which is what points at the C++ destructor.

Fix that measured clean here — clear the transformer in the destructor:

```cpp
FrameCryptor::~FrameCryptor() {
  if (observer_) {
    unregister_observer();
  }
  if (sender_) {
    sender_->SetEncoderToPacketizerFrameTransformer(nullptr);
  }
  if (receiver_) {
    receiver_->SetDepacketizerToDecoderFrameTransformer(nullptr);
  }
}
```

With this, the same soak reads 0 threads after 6 calls (12 cryptors), and
encryption state stays `Ok` at both ends. Happy to open a PR.

## Amended 2026-09-08 (evening): video receivers are left attached

The detach as written segfaults the shell the first time a **video**
receiver's cryptor is dropped. libwebrtc's audio receiver reads a null
transformer as "none"; its video receiver
(`RtpVideoStreamReceiver2::SetDepacketizerToDecoderFrameTransformer`)
wraps the argument in a delegate and dereferences it in `Init()` --
`KERN_INVALID_ADDRESS at 0x0`, on a worker thread, from `~FrameCryptor`
on a tokio worker (the crash report is
`wherry-dev-80c136fd26-2026-09-08-203755.ips`; the run was stage 3N's
first receive of a camera on the native transport). Latent in
production only because nothing publishes video there yet: with
`auto_subscribe` on, any received video track would have taken the app
down at its first unsubscribe, unpublish or room close.

`rust-sdks-frame-cryptor-detach-video.patch` (`wherry/stage-3n`,
`e75845b`) keeps the detach for audio receivers and every sender, and
leaves a video receiver's transformer attached -- the pre-patch leak, for
those tracks only (one thread per received video track per room, D-34's
count). A null-free detach for video would be a pass-through
`FrameTransformerInterface` in place of the cryptor; not built, because
the leak is per call and the crash was per call too. Carry both patches
to the upstream PR together.
