# rust-sdks-room-session-release.patch

One commit on `wherryapp/rust-sdks`, on top of `wherry/windows-console-role`
at `6a32ecc` (the revision `Cargo.toml` pinned before it), for spike row 6:
on the native engine each received video subscription kept one
`FrameCryptorTransformer` thread for the life of the process. `Room::close`
now releases the room session and, with it, the call's `PeerConnection`.

- **Written 2026-09-27** as a text-only proposal, reviewed the same day (the
  review moved part (b) and added part (c), below).
- **Read on the rig 2026-09-27** from a vendored copy of the crate through a
  `[patch]`, on a rig-only branch that was never merged (block I in
  `docs/regression/desktop.md`).
- **Pushed 2026-09-29** at the maintainer's decision (11 of that day) as
  commit `06f0a5d0c59e41fb94c5f84658ca5207103a1647`, a sixth commit on the
  existing branch `wherry/windows-console-role`, so the five before it are
  untouched: <https://github.com/wherryapp/rust-sdks/commit/06f0a5d0c59e41fb94c5f84658ca5207103a1647>.
  `Cargo.toml`'s `rev` pins it and `LIVEKIT_REV` names it. The pushed files
  are byte-identical to the vendored copy block I measured, less its two
  rig-only `Drop` log lines.
- **Read again from the pinned revision 2026-09-29** (*Verification*, below).

`rust-sdks-room-session-release.patch` beside this note is the commit as
`git format-patch` writes it. Like the other fork commits it is meant to go
upstream, as its own pull request (*Upstream*, below).

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

There are three parts:
- **Part (a)** is #1405's two functional hunks, cherry-picked. The test hunk
  is left out because it needs the `__lk-e2e-test` harness.
- **Part (b)** is new: `RoomSession::close()` releases the remote participants
  the same way `handle_restarting` already does. It does so **after**
  `room_task` has been joined, and before `dispatcher.clear()`.
  - Why after: until `room_handle` is joined, `room_task` is still live. Its
    `tokio::select!` is unbiased, so even after `close_tx` fires it can take
    an engine event that was already queued. It also awaits a handler task
    already in flight. A `ParticipantUpdate` handled after the loop would
    re-create the participant (`create_participant`). A `MediaTrack` or
    subscribe event would re-create a publication. Either one re-forms the
    cycle this part exists to break. That happens when the peer is changing
    something at the moment of hang-up, such as a camera flip or a
    permission update, and it would make the fix look flaky rather than
    plainly working or plainly failing.
  - Why before `dispatcher.clear()`: the events it emits still reach the
    shell's pump.
  - One consequence: `incoming_stream_task` has already ended, so the loop's
    `AbortStreamsFrom` send to it fails silently. Ending the task already
    drops every incoming data stream, and Wherry opens none.
  - The first version of this note, written 2026-09-27, ran the loop before
    `close_tx`. Review moved it the same day.
- **Part (c)** is new too, added by the same review: a publisher negotiation
  still waiting for its answer stops when the session closes.
  - The problem: hang-up itself starts negotiations. `voice_disconnect`
    unpublishes the microphone, and `close()` unpublishes the camera, the
    share and the share's sound. Each one calls
    `publisher_negotiation_needed`.
  - In fast-publish mode (`join_response.fast_publish`), that spawns
    `execute_negotiation_with_retry`. The task holds an `Arc<SessionInner>`,
    and through it the publisher `PeerTransport` and the
    `webrtc::PeerConnection`. If its offer went out before the
    PeerConnection closed, it waits up to 10 s for an answer. That answer
    can never come, because the signal task has already been closed. On
    `PendingRetry` it then loops once more.
  - So without (c), the PeerConnection, and with it the video receiver's
    transformer thread, could outlive hang-up by about 10 to 20 s. A redial
    inside that window would run the old `~PeerConnection` during the next
    call.
  - The fix: `SessionInner::close` clears `waiting_for_answer` and calls
    `notify_one` on the negotiation waker. `notify_one` keeps a permit if
    the loop is not waiting yet, so the wake cannot be missed. The loop
    checks `closed` at the top of each pass and after it is woken, then
    goes back to `Idle` and stops.
  - The debounced (non-fast) path already ends within 150 ms. By then its
    offer fails against the closed PeerConnection. The 2026-09-26 rig log
    shows one such failure per hang-up, at the second the call closed:
    `failed to negotiate the publisher: ... Called in wrong state: closed`
    (block A, the spike leg). That log does not show which mode the rig's
    SFU chose, so (c) is believed from the source, not seen.

The diff is `rust-sdks-room-session-release.patch`: `livekit/src/room/mod.rs`
(parts (a) and (b)), `livekit/src/rtc_engine/rtc_events.rs` and
`rtc_session.rs` (part (a)'s `DataChannel` hunk, and part (c)). Nothing in
`webrtc-sys` or `libwebrtc` changes, so the fork's cryptor detach (a video
receiver keeps its transformer) and the console-role change are exactly as
they were.

The change to `close()`'s receiver type compiles against every caller in the
crate:
- `Room::close` and `Room::close_with_reason` call it through `self.inner`,
  which is an `Arc`.
- `handle_disconnected` calls it through its own `Arc` clone.

Compiled on Windows from the pinned revision (the rig build, 2026-09-29), and
on macOS from the vendored copy (`cargo check`, 2026-09-27). `rustfmt --check`
passes the three files with the fork's own `rustfmt.toml`.

## Is it safe against the video segfault? (read on the rig; the reasoning is believed)

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
stream's `Reset()`, so this is believed not to happen. The rig has not seen
it. The vendored copy (block I) destroyed 28 PeerConnections, at least ten of
them with a received video track. The pinned revision destroyed 18, eleven of
them with one. Neither crashed or hung at close (*Verification*).
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
  - **Its fallback matters too.** `hold_media_engine` can fail
    (`EngineHold::Failed`), and `voice_connect` then goes ahead with the call.
    Until now that was safe only because of this leak: the call's own
    PeerConnection was never destroyed, so it kept the engine initialised
    for the rest of the process. With this change in, a failed hold would
    leave the call's PeerConnection as the engine's last reference. Hanging
    up would then run `Terminate` into the ADM the shell keeps through
    `PlatformAudio`, and if the next hold also failed, the D-67 device
    defect would repeat on every call instead of only the first. On
    ~PeerConnection in `pc/peer_connection.cc` at webrtc-sdk `89d790b`:
    the destructor does `media_engine_ref_.reset()` (`Close()` does not), so
    it is the destructor that would run `Terminate`.
    - **The shell handles it** (2026-09-27, `voice_connect` after
      `Room::connect`): when the hold failed before the connect, it is tried
      again once the call is connected. The call's PeerConnection is alive
      and has already initialised the engine, so creating the hold only adds
      a reference and runs no `Init`. The defect stays with that one call, as
      before, and hang-up no longer releases the last reference. Before this
      commit it did nothing, because no PeerConnection was ever released.
    - **The remaining risk** is two failures in a row: the hold fails before
      the connect **and** after it. The log says so at warn level (`could
      not hold the media engine after connect either`), and that call's
      hang-up can terminate the engine. A connect that itself fails after a
      failed hold is the same risk, and the shell cannot reach it: it has no
      PeerConnection alive to take the hold beside. Refusing the call
      instead was rejected. It would turn a rare device defect on one call
      into no call at all, and nothing has ever been seen to make
      `create_peer_connection` fail.
  - Row: `~PeerConnection` should appear once per call, and
    `WebRtcVoiceEngine::Terminate` should still read 0. The log should show
    `media engine initialised and held` on the first call and `already
    held` on every later one, and never `could not hold`. **Read so on the
    rig from the pinned revision** (2026-09-29, 18 sessions; *Verification*).
    The fallback cannot be forced on the rig without a fault injection, so
    it is believed from the source, not verified.
- **Events at close.** `handle_participant_disconnect` emits
  `TrackUnsubscribed`, `TrackUnpublished` and `ParticipantDisconnected` for
  each participant still in the room. It does so inside `room.close()`,
  after `room_task` has stopped and before the dispatcher is cleared, while
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

## Verification

**Verified on the Windows rig, twice.** Both readings are on Windows 11 Pro
26200 under WARP, a `--debug` bundle with `WHERRY_WEBRTC_LOG=1`, one fresh
shell process, the in-guest Edge peer, and both cameras on: the peer's is
Chromium's fake one, the shell's the guest's virtual camera. Threads are
counted by name with `scripts/rig/guest/thread-names.ps1`. `~PeerConnection`
is libwebrtc's own `PeerConnection::~PeerConnection()` line.

**Before the change** (block H, 2026-09-27, `rig/candidate-plus`, the fork at
`6a32ecc`), five video calls in one process:

| | Cryptor threads during / after |
|---|---|
| Shell hangs up first | 4 / 1, 5 / 2, 6 / 3 |
| Peer hangs up first | 7 / 4, 8 / 5 |
| `~PeerConnection` | 0 in 5 calls |

**Vendored copy** (block I, 2026-09-27, `rig/batch4`). The change was applied
to a copy of the crate through a `[patch]`, plus two `Drop` log lines, in
27 calls:

| | Cryptor threads during / after | After `voice: session closed` |
|---|---|---|
| Shell hangs up first, 6 calls | 4 / **0** each | `RoomSession dropped` +1 to +4 ms, `PeerTransport Publisher dropped` +1 to +5 ms, `~PeerConnection` +3 to +20 ms |
| Peer hangs up first, 2 calls | 4 / 0 | `PeerTransport` +1 ms, `~PeerConnection` +2 ms |
| Peer flips its camera before the shell hangs up, 2 calls | 4 / 0 | `~PeerConnection` +38 / +4 ms |

Over the whole process: `PeerConnection()` 29, `~PeerConnection` 28 (only
the idle media-engine one survives). `WebRtcVoiceEngine::Terminate` 0.

**Pinned revision** (2026-09-29, 15:54 to 16:28 UTC):
- **The build.** The pin commit on `rig/fork-pin-0929`, built as `2b43602`
  on `c2a93d0`. `main`'s tip `28b1fa7` adds one docs file to that, so the
  application tree is `main` plus the pin. `WherryBuild`: typecheck, the client tests and
  tauri all rc 0. Cargo fetched `06f0a5d` from GitHub and compiled
  `webrtc-sys`, `libwebrtc` and `livekit` from it. The guest's checkout of
  the three changed files hashes equal to the pushed ones (SHA-256
  `8a5410e2…` `room/mod.rs`, `8d05fc8f…` `rtc_events.rs`, `3773f4bf…`
  `rtc_session.rs`). Installed `wherry-desktop.exe`: 53,056,512 bytes,
  SHA-256 `DB455388B4871B951D11D27B2B07CB9A79A497357D9C3C6FB866DF6D1DFA0687`.
- **Idle, before any call:** 19 threads, 0 `FrameCryptorTransformer`.
- **The census.** In each call both cameras were on for 20 s, then a
  census; then the hang-up. The log was then polled for `voice: session
  closed` and `~PeerConnection`, and a second census taken.

  | Leg | Cryptor threads during / after | Threads during / after |
  |---|---|---|
  | Shell hangs up first, 7 calls (the seventh after the D-84 leg) | **4 / 0** in every call | 38–42 / 21–24 |
  | Peer hangs up first, 2 calls (the shell 3 s later) | 4 / 0, 4 / 0 | 39–40 / 21–22 |
  | Peer turns its camera off and on just before the shell hangs up, 2 calls | 4 / 0, 4 / 0 | 38–40 / 20–22 |

- **`~PeerConnection`** was logged once per call, as the very next line after
  `voice: session closed`, in the same logged second. Nothing near 10 or
  20 s, so part (c) held.
  - The log's timestamps have a resolution of one second. The pinned build
    has no `livekit[rig]` lines, so block I's millisecond delays are not
    re-read here, only their order.
- **S-18's shape, twice.** A call shares a screen with sound and stops it
  (`screen audio muted after … kept published`), then hangs up. The next
  call connected, and the shell was still answering 12 s into it. This
  matters because the call's PeerConnection is now destroyed between the
  two calls.
- **The whole process, 18 sessions.** These are the eleven census calls,
  S-18's four, and the D-84 leg's three (`turn-relay-plan.md`, T4 stage log),
  run in the same process:
  - `PeerConnection()` 19 and `~PeerConnection` **18**: only the idle
    `MEDIA_ENGINE` hold survives.
  - `WebRtcVoiceEngine::Terminate` **0**.
  - `media engine initialised and held` once, then `already held` 17 times;
    `could not hold` 0.
  - `panicked` 0, no access violation, `OperationFailed` 0 and `last start
    failed` 0 (D-74).
  - Final census: 21 threads, 0 `FrameCryptorTransformer`.
- **One reading, recorded, not judged.** `voice: session closed in N ms`
  read 23 to 241 ms on the calls with cameras and 40 to 92 ms on those
  without.
  - Block I's vendored build read 2 to 361 ms over 27 sessions.
  - Earlier builds' rig logs, 2026-09-26 and the morning of 2026-09-27, read
    0 to 135 ms.
  - Close now includes releasing the participants, and the PeerConnection is
    destroyed on the line after it.
  - Row D-21 asks for under 100 ms, a bar written for audio-only calls on
    macOS. The rig cannot settle a timing (`docs/windows-rig.md` §8).

**Not read:**
- a redial inside the old 10 s window (nothing lags now, so nothing to
  catch);
- the hold's retry after a failed hold (it needs a fault injection);
- macOS, from the pinned revision. The Mac's scratch disk had 3.6 GB free,
  below the 5 GB this build needs. The vendored copy passed `cargo check`
  there on 2026-09-27.

## Upstream — drafted, not filed

Part (a) is already upstream (#1405), so rebasing the fork onto an upstream
that contains it drops part (a) from this commit. Parts (b) and (c) are not
upstream. They go as their own pull request beside #1408, carried with the
other fork commits (CLAUDE.md, *Carry all fork commits upstream together*),
once the CLA for #1408 is signed. Filing is the maintainer's.

**Title:** Room::close leaves remote participants, and a waiting fast-publish
negotiation, holding the RtcEngine and its PeerConnection

After `Room::close()`, the session's `PeerConnection` is never destroyed
while a remote participant is still in the room at hang-up. Two things keep
it alive:
- Each `RemoteTrackPublication`'s `on_subscribed` / `on_unsubscribed`
  closures (`RemoteParticipant::add_publication`) capture the participant,
  and the participant holds the publication and an `Arc<RtcEngine>`. Only
  `remove_publication` breaks that cycle. It runs when a participant leaves
  or unpublishes, and on a full reconnect (`handle_restarting`), but not in
  `RoomSession::close()`.
- In fast-publish mode, the unpublishes that `close()` itself performs start
  `execute_negotiation_with_retry`. That task holds `Arc<SessionInner>` for
  up to its 10 s answer timeout (and one retry), and the answer cannot
  arrive once the signal client is closed.

Where frame encryption is on, every received video track's
`FrameCryptorTransformer` and its thread live as long as that
`PeerConnection`, so they are never reclaimed. Reproduction (Windows 11,
E2EE, a remote peer publishing a camera): connect, subscribe, `close()` while
the peer is still in the room, and drop the `Room`. Repeat N times, then
count threads by name (`GetThreadDescription`). `PeerConnection::~PeerConnection`
never logs.

The fix in this commit:
- `close()` calls `handle_participant_disconnect` for each remaining
  participant after `room_task` is joined and before `dispatcher.clear()`.
- `SessionInner::close` wakes and ends a waiting negotiation.

With it, over 18 calls the thread count returns to the pre-call number after
every hang-up, and `~PeerConnection` runs once per call (numbers above).
Happy to open a PR.
