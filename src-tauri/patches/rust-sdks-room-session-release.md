# rust-sdks-room-session-release (proposed, not applied, not built)

A fork change on `wherryapp/rust-sdks`, written 2026-09-27. It would go on top
of `wherry/windows-console-role` at `6a32ecc`, which is the revision
`Cargo.toml` pins. It is for spike row 6: one `FrameCryptorTransformer` thread
is kept per received video subscription on the native engine. The diff below
exists only as text. **No fork branch was made, nothing was compiled, and
nothing was measured.** `rustfmt --check` parses the three edited files; that
is the only check that has run.

Once it is pushed:
1. Pin it with `rev` in `client/src-tauri/Cargo.toml`.
2. Name it in `LIVEKIT_REV` (`src/voice/mod.rs`).
3. Give the next rig pass the reading under *How to verify*.

## What was seen

- **The rig, 2026-09-26** (`docs/status.md`, the spike-row-6 bullet; the rig
  results in block A, §5): each call with video made 4 cryptor threads and
  left 1 behind. After 6 calls there were 6. A call that received no video
  left none. A re-subscribe within a call leaves one more.
- **Block B, the same day, §1.2:**
  - `PeerConnection::PeerConnection()` ran 3 times over three calls.
  - `PeerConnection::~PeerConnection()` ran **0** times, even 2.5 minutes after
    the last hang-up.
  - `WebRtcVoiceEngine::Terminate` also ran 0 times.

## Who owns the thread (traced from source, not from a debugger)

In the prebuilt libwebrtc (`webrtc-89d790b`,
`api/crypto/frame_crypto_transformer.h`), each `FrameCryptorTransformer` owns a
`std::unique_ptr<webrtc::Thread>`. The thread stops only in the transformer's
destructor, so it lives exactly as long as the last `scoped_refptr` to the
transformer. For a received **video** track, these hold one:

1. **The webrtc-sys `FrameCryptor`.** It is dropped when `E2eeManager` removes
   it: on `TrackUnsubscribed`, and in `cleanup()` at room close. This already
   works.
2. **The receive stream's `RtpVideoStreamReceiverFrameTransformerDelegate`.**
   It and the transformer hold each other (the transformer's
   `sink_callbacks_[ssrc]`). The cycle is broken by the delegate's `Reset()`
   when the receive stream is destroyed. `PeerConnection::Close()` does that
   when it destroys the media channels. This also already works.
3. **`VideoRtpReceiver::frame_transformer_`.** The receiver keeps the
   transformer so it can apply it again to a new media channel. In our fork
   (`rust-sdks-frame-cryptor-detach-video.patch`), `~FrameCryptor` does **not**
   clear this for a video receiver, because a null here is the
   `RtpVideoStreamReceiverFrameTransformerDelegate::Init()` segfault. Nothing
   else clears it until the `VideoRtpReceiver` is destroyed. A closed
   PeerConnection keeps its transceivers, so that means when the
   `webrtc::PeerConnection` itself goes.

Audio receivers do not leak, because the fork's detach does set their
transformer to null. That is why the audio-only macOS soak read 0.

**So the thread lives as long as the `PeerConnection`, and the PeerConnection
is never destroyed.** Two ownership cycles in the `livekit` crate cause that.

### Cycle 1: the room session holds itself

In `Room::connect` (`livekit/src/room/mod.rs`),
`e2ee_manager.on_state_changed` is given a closure that captures
`inner.clone()`, a strong `Arc<RoomSession>`. The handler is stored in the
`E2eeManager`, which is itself a field of `RoomSession`, and `cleanup()` never
clears it. So every `RoomSession` outlives `Room::close()` and the shell's
`drop(room)`. It is registered whether or not E2EE is on, so every call
leaks it.

The chain from there to the thread:
- `RoomSession` holds `RtcEngine`.
- `RtcEngine` holds `EngineInner`, which keeps `running_handle.session` on
  purpose ("the RtcSession is not removed so we can still access stats").
- `RtcSession` holds `SessionInner`, which holds the publisher and subscriber
  `PeerTransport`s.
- Those hold the webrtc-sys `PeerConnection` wrapper, which holds the
  `webrtc::PeerConnection`. In single-PeerConnection mode, the default, there
  is only one.
- That holds the transceivers, then the `VideoRtpReceiver`, then the
  transformer, then the thread.

**Upstream has already fixed this one:** livekit/rust-sdks#1405, *Room
lifecycle memory fixes*, `16530d20569174f705fad8cb77e185ae392abefd`, merged
2026-09-08. It changed the capture to `Arc::downgrade`. It also removed a
`DataChannel` that captured itself from its own buffered-amount callback. The
PR reports 1,000 connect/disconnect cycles going from ~488 MiB RSS to 44 MiB,
"with stable thread and file-descriptor counts". Our base, `dee418bb`, is
older than that commit.

### Cycle 2: a remote participant still in the room at close

Upstream is believed to still have this one.
`RemoteParticipant::add_publication` registers `on_subscribed` and
`on_unsubscribed` on each publication. Both closures capture `self.clone()`,
the participant, while the participant holds the publication. Only
`remove_publication` replaces those closures. That runs when a participant
leaves or a track is unpublished, and on a full reconnect
(`handle_restarting`). It does not run in `RoomSession::close()`.

So when the shell hangs up while the peer is still in the call, that
participant keeps:
- its publications;
- their `RemoteTrack`s, each holding its `RtpTransceiver`, and so the
  `VideoRtpReceiver`;
- its `Arc<RtcEngine>`, and so the whole chain above.

Fixing cycle 1 alone would therefore release the PeerConnection only when the
peer happened to leave first.

## Why there is no shell-side fix

There are three edges the shell might try to cut, and it can reach none of
them:

| Edge | Why the shell cannot cut it |
|---|---|
| The e2ee handler | `E2eeManager::on_state_changed` is `pub(crate)`, and nothing public replaces or clears it. |
| The participant's publications | `RemoteParticipant::unpublish_track` and `remove_publication` are `pub(crate)`. |
| The receiver's transformer | The shell could only replace it with another `FrameCryptorTransformer`, which is one thread for another. Replacing it on a live receive stream leaves the old delegate cycle (2 above) unbroken anyway. |

The shell already drops everything it holds at hang-up:
- `voice_disconnect` drops the `Room`, the `KeyProvider` and the microphone
  publication, and aborts the pump.
- `video::teardown` drops the tiles, the camera, the share and the share's
  sound.
- A tile's `NativeVideoStream` holds the `VideoTrack`, not the receiver.

So the fix belongs in the fork.

## The change

There are two parts:
- **Part (a)** is #1405's two functional hunks, cherry-picked. The test hunk
  is left out because it needs the `__lk-e2e-test` harness.
- **Part (b)** is new: `RoomSession::close()` releases the remote participants
  the same way `handle_restarting` already does.

```diff
--- a/livekit/src/room/mod.rs
+++ b/livekit/src/room/mod.rs
@@ -759,8 +759,14 @@
 
         e2ee_manager.on_state_changed({
             let dispatcher = dispatcher.clone();
-            let inner = inner.clone();
+            // Weak: the manager is a field of `RoomSession`, so a strong capture
+            // here is a cycle that keeps the session -- and through the engine
+            // every PeerConnection it ever created -- alive after `close()`.
+            let weak_inner = Arc::downgrade(&inner);
             move |participant_identity, state| {
+                let Some(inner) = weak_inner.upgrade() else {
+                    return;
+                };
                 // Forward e2ee events to the room
                 // (Ignore if the participant is not in the room anymore)
 
@@ -1164,7 +1170,7 @@
         Ok(())
     }
 
-    async fn close(&self, reason: DisconnectReason) -> RoomResult<()> {
+    async fn close(self: &Arc<Self>, reason: DisconnectReason) -> RoomResult<()> {
         let Some(handle) = self.handle.lock().await.take() else { Err(RoomError::AlreadyClosed)? };
 
         // remove published tracks
@@ -1174,6 +1180,20 @@
 
         self.rtc_engine.close(reason).await;
         self.e2ee_manager.cleanup();
+
+        // Release every remote participant still in the room, the way a full
+        // reconnect does (`handle_restarting`). Each remote publication holds
+        // callbacks that capture its participant, and the participant holds
+        // the publication and the `RtcEngine`: a cycle that `remove_publication`
+        // is the only thing to break. Left in place, it keeps the engine's
+        // session -- its PeerConnection(s), every transceiver, and each subscribed
+        // track's `RtpReceiver` -- alive for the life of the process, which is
+        // where a video receiver's frame transformer (and its thread) lives.
+        let participants: Vec<RemoteParticipant> =
+            self.remote_participants.read().values().cloned().collect();
+        for participant in participants {
+            self.clone().handle_participant_disconnect(participant);
+        }
 
         let _ = handle.close_tx.send(());
         let _ = handle.incoming_forward_task.await;
--- a/livekit/src/rtc_engine/rtc_events.rs
+++ b/livekit/src/rtc_engine/rtc_events.rs
@@ -60,7 +60,6 @@
     },
     DataChannelBufferedAmountChange {
         sent: u64,
-        amount: u64,
         kind: DataPacketKind,
     },
 }
@@ -166,16 +165,15 @@
 
 fn on_buffered_amount_change(
     emitter: RtcEmitter,
-    dc: DataChannel,
     kind: DataPacketKind,
 ) -> rtc::data_channel::OnBufferedAmountChange {
+    // Never capture the DataChannel here: the callback is stored on it.
     Box::new(move |sent| {
-        let amount = dc.buffered_amount();
-        let _ = emitter.send(RtcEvent::DataChannelBufferedAmountChange { sent, amount, kind });
+        let _ = emitter.send(RtcEvent::DataChannelBufferedAmountChange { sent, kind });
     })
 }
 
 pub fn forward_dc_events(dc: &mut DataChannel, kind: DataPacketKind, rtc_emitter: RtcEmitter) {
     dc.on_message(Some(on_message(rtc_emitter.clone(), kind)));
-    dc.on_buffered_amount_change(Some(on_buffered_amount_change(rtc_emitter, dc.clone(), kind)));
+    dc.on_buffered_amount_change(Some(on_buffered_amount_change(rtc_emitter, kind)));
 }
--- a/livekit/src/rtc_engine/rtc_session.rs
+++ b/livekit/src/rtc_engine/rtc_session.rs
@@ -1675,7 +1675,7 @@
                     );
                 }
             }
-            RtcEvent::DataChannelBufferedAmountChange { sent, amount: _, kind } => {
+            RtcEvent::DataChannelBufferedAmountChange { sent, kind } => {
                 let ev = DataChannelEvent {
                     kind,
                     detail: DataChannelEventDetail::BufferedAmountChange(sent),
```

The change to `close()`'s receiver type compiles against every caller in the
crate:
- `Room::close` and `Room::close_with_reason` call it through `self.inner`,
  which is an `Arc`.
- `handle_disconnected` calls it through its own `Arc` clone.

This is read from the source, not compiled.

## Is it safe against the video segfault? (believed)

The segfault needed a **null** handed to
`SetDepacketizerToDecoderFrameTransformer` on a live video receive stream. This
change hands a null to nothing. Here is how teardown runs with it:
- `Close()` still destroys the receive streams first. That resets the
  delegates, which is libwebrtc's own path.
- Later, the last `scoped_refptr` to the `webrtc::PeerConnection` goes, and
  the transceivers and `VideoRtpReceiver`s go with it.
- By then the receiver's media channel is already null (`Stop()` ran in
  `Close()`), so its destructor touches no stream.
- The transformer's last reference is dropped, and its destructor joins its
  thread.

This is the teardown every browser tab runs on close. The detach patch stays
exactly as it is: video receivers still keep their transformer while the
PeerConnection lives.

The one ordering this cannot rule out without a run: the last reference being
dropped **on the transformer's own thread**, which would make it join itself.
Nothing found in the headers posts work that holds a reference past the
stream's `Reset()`, so this is believed not to happen.

## What else changes once PeerConnections are destroyed

- **The media engine can now be terminated.** Until now,
  `WebRtcVoiceEngine::Terminate` could not run, because no PeerConnection was
  ever released (block B §1.2: "the latent hazard ... does not fire on this
  build"). With this change, a call's PeerConnection is released at hang-up.
  - The shell's `MEDIA_ENGINE` hold in `src/voice/mod.rs` is what keeps the
    engine initialised now. It is one idle PeerConnection, never dropped.
  - **It must stay.** If it were removed with this change in, the engine would
    terminate after every call, and the ADM `Terminate` hazard from the
    adm-select work would become live.
  - Row: `~PeerConnection` should appear once per call, and
    `WebRtcVoiceEngine::Terminate` should still read 0.
- **Events at close.** `handle_participant_disconnect` emits
  `TrackUnsubscribed`, `TrackUnpublished` and `ParticipantDisconnected` for
  each participant still in the room. It does so inside `room.close()`, while
  the shell's pump is still running. livekit-client in the browser does the
  same on disconnect.
  - The pump handles these events as it would mid-call: the roster, and
    `video::on_unsubscribed` / `on_video_event`.
  - `video::teardown` has already taken `VIDEO` by then, so `with_state`
    recreates an empty state for the ending session. It holds no track and
    is replaced by the next connect.
  - Every event is tagged with the ending session's id, which the page
    discards. This is harmless and needs no shell change.
  - The e2ee manager's `on_track_unsubscribed` finds its map already cleared,
    so it does nothing.
- **Within a call, nothing changes.** A video subscription that ends
  mid-call still keeps its thread until the call ends. The
  `VideoRtpReceiver` stays alive with its transceiver. If the SFU recycles
  that transceiver for a later video track, installing the new cryptor
  replaces and releases the old transformer. The number of threads a call
  holds is bounded by what that call subscribed to, and hang-up releases
  them all.

## How to verify (rig, a `--debug` bundle)

These values should be read on the Windows rig.

1. Make a debug bundle with `WHERRY_WEBRTC_LOG=1`, so the LS_VERBOSE
   `PeerConnection::~PeerConnection()` line is written.
2. Run a fresh process. Count threads with
   `C:\rig\scripts\thread-names.ps1` (a by-name count of
   `FrameCryptorTransformer`).
3. Run six calls against `peer`. In each call, the peer answers and turns its
   camera on, and the shell turns its camera on. Wait 20 s, take a census,
   hang up **the shell first**, wait 5 s, take a census.
4. Expect:
   - 4 cryptor threads during each call, and **0** after each hang-up
     (was 1, 2, … 6);
   - one `~PeerConnection` per call. `single_peer_connection` defaults to on, and block B read one `PeerConnection()` per call. The shell's idle `MEDIA_ENGINE` PeerConnection is the one constructor per process that should never be matched by a destructor;
   - `WebRtcVoiceEngine::Terminate` 0 times;
   - no crash.
5. Repeat with **the peer hanging up first**, and with a camera off/on flip
   inside one call. The thread count should still return to 0 after
   hang-up.
6. Run S-18 and D-74 again. The PeerConnection's destruction is new, and
   those rows live near it.

## Upstream

Part (a) is already upstream (#1405). Part (b) should go upstream as its own
PR alongside #1408: *"Room::close leaves remote participants' publication
callbacks in a cycle that keeps the RtcEngine alive"*, with the rig's reading
as its evidence once it exists. Rebasing the fork onto an upstream that
contains #1405 would drop part (a) from this commit.
