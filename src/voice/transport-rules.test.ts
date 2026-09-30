import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectFailureClosesShell,
  defaultInputId,
  cameraCeilingFor,
  connectionFromWord,
  disconnectSfuStopping,
  disconnectWasTold,
  isEncryptionFailure,
  knownDeviceId,
  nativeErrorName,
  nativeGainFor,
  playbackEnabledFor,
  playoutAfterDeviceChange,
  playoutReadingChanged,
  publishErrorMessage,
  qualityFromWord,
  ROOM_FOLLOW_UP_EVERY_MS,
  ROOM_FOLLOW_UP_FOR_MS,
  roomFollowUpStep,
  roomProbeUrl,
  roomProbeVerdict,
  SCREEN_AUDIENCE_STEP,
  screenAudioCapture,
  screenAudioMode,
  screenAudioNote,
  screenAudioPublish,
  SCREEN_AUDIO_BITRATE,
  screenOptionsFor,
  screenSourceKind,
  tileRect,
  transportEndFor,
  volumeKey,
  userIdFromMetadata,
  videoCodecFor,
  videoOptionsFor,
} from "./transport-rules";

describe("userIdFromMetadata", () => {
  it("reads the account the server put in the metadata", () => {
    assert.equal(userIdFromMetadata(JSON.stringify({ userId: "u1" }), "dev-1"), "u1");
  });
  it("falls back to the identity when the metadata is missing or malformed", () => {
    assert.equal(userIdFromMetadata(undefined, "dev-1"), "dev-1");
    assert.equal(userIdFromMetadata("", "dev-1"), "dev-1");
    assert.equal(userIdFromMetadata("not json", "dev-1"), "dev-1");
    assert.equal(userIdFromMetadata(JSON.stringify({ userId: 7 }), "dev-1"), "dev-1");
  });
});

describe("nativeErrorName", () => {
  it("maps the shell's codes onto the browser names session.ts already reads", () => {
    assert.equal(nativeErrorName("no_microphone"), "NotFoundError");
    assert.equal(nativeErrorName("mic_failed"), "UnknownError");
    assert.equal(nativeErrorName(""), "UnknownError");
  });

  it("knows the camera's and the screen's codes, not only the microphone's", () => {
    assert.equal(nativeErrorName("no_camera"), "NotFoundError");
    assert.equal(nativeErrorName("camera_denied"), "NotAllowedError");
    assert.equal(nativeErrorName("screen_cancelled"), "NotAllowedError");
    // Not every native failure has a sentence of its own; these fall to the
    // generic one on purpose.
    assert.equal(nativeErrorName("camera_failed"), "UnknownError");
    assert.equal(nativeErrorName("screen_failed"), "UnknownError");
  });

  it("gives a window that closed after it was picked its own name", () => {
    assert.equal(nativeErrorName("screen_gone"), "SourceGoneError");
    const gone = Object.assign(new Error("that window or screen is no longer there"), {
      name: nativeErrorName("screen_gone"),
    });
    assert.equal(
      publishErrorMessage(gone, "screen"),
      "The window or screen you chose is no longer there.",
    );
  });

  it("words a Windows camera refusal as a refusal, whatever stage raised it", () => {
    // The old Windows text matched the SFU-refusal patterns ("not allowed"
    // and "source"); the name is what decides now.
    for (const text of [
      "camera access is not allowed (creating the source reader)",
      "camera access was refused (creating the source reader)",
      "camera access is not allowed",
    ]) {
      const denied = Object.assign(new Error(text), { name: nativeErrorName("camera_denied") });
      assert.equal(publishErrorMessage(denied, "camera"), "Camera access was refused.");
    }
  });

  // The name is the middle of the path, not the point of it. What broke was
  // the sentence, so the sentence is what this asserts.
  it("carries a denied camera all the way to the words a person reads", () => {
    const denied = Object.assign(new Error("camera access is not allowed"), {
      name: nativeErrorName("camera_denied"),
    });
    assert.equal(publishErrorMessage(denied, "camera"), "Camera access was refused.");
    const missing = Object.assign(new Error("no camera on this device"), {
      name: nativeErrorName("no_camera"),
    });
    assert.equal(publishErrorMessage(missing, "camera"), "No camera was found.");
    const cancelled = Object.assign(new Error("the picker was dismissed"), {
      name: nativeErrorName("screen_cancelled"),
    });
    assert.equal(
      publishErrorMessage(cancelled, "screen"),
      "Screen sharing was refused or cancelled.",
    );
  });
});

describe("playbackEnabledFor", () => {
  it("enables the track only above silence, whatever the gain says", () => {
    assert.equal(playbackEnabledFor(0), false);
    assert.equal(playbackEnabledFor(0.01), true);
    assert.equal(playbackEnabledFor(1), true);
  });
});

describe("nativeGainFor", () => {
  it("is the volume itself inside 0..1", () => {
    assert.equal(nativeGainFor(0), 0);
    assert.equal(nativeGainFor(0.4), 0.4);
    assert.equal(nativeGainFor(1), 1);
  });
  it("never makes anybody louder than they sent themselves, and never NaN", () => {
    assert.equal(nativeGainFor(3), 1);
    assert.equal(nativeGainFor(-1), 0);
    assert.equal(nativeGainFor(Number.NaN), 1);
  });
});

describe("isEncryptionFailure", () => {
  it("counts the states that mean a frame did not open, and nothing else", () => {
    for (const state of ["EncryptionFailed", "DecryptionFailed", "MissingKey", "InternalError"]) {
      assert.equal(isEncryptionFailure(state), true, state);
    }
    for (const state of ["Ok", "New", "KeyRatcheted", ""]) {
      assert.equal(isEncryptionFailure(state), false, state);
    }
  });
});

describe("the shell's words", () => {
  it("become the transport's quality and connection vocabulary", () => {
    assert.equal(qualityFromWord("excellent"), "excellent");
    assert.equal(qualityFromWord("lost"), "lost");
    assert.equal(qualityFromWord("Excellent"), "unknown");
    assert.equal(connectionFromWord("reconnecting"), "reconnecting");
    assert.equal(connectionFromWord("closed"), null);
  });
});

describe("knownDeviceId", () => {
  const devices = [{ deviceId: "a" }, { deviceId: "b" }];
  it("keeps an id the shell can still see", () => {
    assert.equal(knownDeviceId("b", devices), "b");
  });
  it("drops an unknown one -- another id space, or unplugged -- to the default", () => {
    assert.equal(knownDeviceId("browser-era-id", devices), null);
    assert.equal(knownDeviceId(null, devices), null);
    assert.equal(knownDeviceId("a", []), null);
  });
  it("treats the empty string as no id, even when the list is full of them", () => {
    // A browser that has not been granted the microphone yet answers
    // enumerateDevices with every deviceId blank. Matching one of those and
    // passing "" on as an exact constraint is an OverconstrainedError on a
    // machine whose microphone is fine.
    assert.equal(knownDeviceId("", devices), null);
    assert.equal(knownDeviceId("", [{ deviceId: "" }, { deviceId: "" }]), null);
  });
});

describe("playoutAfterDeviceChange", () => {
  const hda = "{0.0.0.00000000}.{afca49a9-916c-4cc6-adfc-7858b8eb7b2e}";
  const usb = "{0.0.0.00000000}.{ff606fbf-7935-40e8-8eb0-37e4452798b8}";
  const both = [{ deviceId: hda }, { deviceId: usb }];
  const onlyHda = [{ deviceId: hda }];

  it("leaves a shell that reports no default alone, chosen or not (macOS, older shells)", () => {
    for (const chosen of [null, usb, "gone"]) {
      for (const following of [true, false]) {
        assert.deepEqual(
          playoutAfterDeviceChange({ chosen, outputs: onlyHda, defaultOutput: undefined, following }),
          { kind: "stay" },
        );
      }
    }
  });

  it("follows the default when nothing is chosen: a default change, an unplug, an output returning", () => {
    // D-72: the Windows default moved from HDA to USB mid-call.
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: null, outputs: both, defaultOutput: usb, following: true }),
      { kind: "follow-default" },
    );
    // D-72: the device playing was unplugged; Windows' default is HDA again.
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: null, outputs: onlyHda, defaultOutput: hda, following: true }),
      { kind: "follow-default" },
    );
    // D-73: a call begun with no output; still asked while there is none,
    // and the shell says there is nothing to follow.
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: null, outputs: [], defaultOutput: null, following: true }),
      { kind: "follow-default" },
    );
  });

  it("stays on a chosen speaker that is still there, whatever the default does", () => {
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: usb, outputs: both, defaultOutput: hda, following: false }),
      { kind: "stay" },
    );
  });

  it("falls back to the default when the chosen speaker goes, rather than going silent", () => {
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: usb, outputs: onlyHda, defaultOutput: hda, following: false }),
      { kind: "follow-default" },
    );
    // A webview-era id is never in the shell's list: the default, as at connect.
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: "browser-id", outputs: both, defaultOutput: hda, following: true }),
      { kind: "follow-default" },
    );
  });

  it("goes back to the chosen speaker when it returns after a fallback", () => {
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: usb, outputs: both, defaultOutput: usb, following: true }),
      { kind: "device", deviceId: usb },
    );
  });

  it("treats an empty chosen id as nothing chosen", () => {
    assert.deepEqual(
      playoutAfterDeviceChange({ chosen: "", outputs: both, defaultOutput: hda, following: false }),
      { kind: "follow-default" },
    );
  });
});

describe("playoutReadingChanged", () => {
  const hda = { deviceId: "{0.0.0.00000000}.{afca49a9-916c-4cc6-adfc-7858b8eb7b2e}" };
  const usb = { deviceId: "{0.0.0.00000000}.{ff606fbf-7935-40e8-8eb0-37e4452798b8}" };

  it("says nothing moved when the outputs and the default are the same", () => {
    assert.equal(
      playoutReadingChanged(
        { outputs: [hda, usb], defaultOutput: hda.deviceId },
        { outputs: [{ ...hda }, { ...usb }], defaultOutput: hda.deviceId },
      ),
      false,
    );
    // A shell that reports no default, both times.
    assert.equal(playoutReadingChanged({ outputs: [hda] }, { outputs: [hda] }), false);
  });

  it("sees an output appear during the connect of a call begun with none (D-73)", () => {
    assert.equal(
      playoutReadingChanged({ outputs: [], defaultOutput: null }, { outputs: [usb], defaultOutput: usb.deviceId }),
      true,
    );
  });

  it("sees the default move with the list unchanged, and an unplug", () => {
    assert.equal(
      playoutReadingChanged(
        { outputs: [hda, usb], defaultOutput: hda.deviceId },
        { outputs: [hda, usb], defaultOutput: usb.deviceId },
      ),
      true,
    );
    assert.equal(
      playoutReadingChanged(
        { outputs: [hda, usb], defaultOutput: hda.deviceId },
        { outputs: [hda], defaultOutput: hda.deviceId },
      ),
      true,
    );
  });

  it("counts a reorder as a change, since the shell selects by index", () => {
    assert.equal(
      playoutReadingChanged(
        { outputs: [hda, usb], defaultOutput: hda.deviceId },
        { outputs: [usb, hda], defaultOutput: hda.deviceId },
      ),
      true,
    );
  });
});

describe("videoCodecFor", () => {
  it("pins H.264, and that is the one line stopping a silent camera", () => {
    // The measurement behind this (docs/prompts/video-plan.md §9.1): AV1
    // publishes, the local preview looks perfect, the encoder counts
    // frames, and bytesSent stays at 0 because livekit-client's E2EE
    // worker throws before the encryption try and kills the transform
    // stream for good. Nothing about that is visible from the publisher's
    // side, which is why this is a function with a test.
    assert.equal(videoCodecFor(true), "h264");
    assert.equal(videoCodecFor(false), "h264");
  });
});

describe("cameraCeilingFor", () => {
  const granted = { maxHeight: 720, maxFps: 30 };
  it("lets a tier ask for less than the grant", () => {
    assert.deepEqual(cameraCeilingFor(granted, "standard"), { maxHeight: 360, maxFps: 30 });
  });
  it("never lets a tier ask for more", () => {
    assert.deepEqual(cameraCeilingFor(granted, "hd"), { maxHeight: 720, maxFps: 30 });
    assert.deepEqual(cameraCeilingFor({ maxHeight: 360, maxFps: 30 }, "hd"), {
      maxHeight: 360,
      maxFps: 30,
    });
  });
  it("caps auto at 720 -- 1080 on a laptop battery is a decision nobody made", () => {
    assert.deepEqual(cameraCeilingFor({ maxHeight: 1080, maxFps: 30 }, "auto"), {
      maxHeight: 720,
      maxFps: 30,
    });
    assert.deepEqual(cameraCeilingFor({ maxHeight: 1080, maxFps: 30 }, "hd"), {
      maxHeight: 1080,
      maxFps: 30,
    });
  });
  it("answers null for a source the grant does not carry", () => {
    assert.equal(cameraCeilingFor(null, "hd"), null);
  });
});

describe("videoOptionsFor", () => {
  const grant = {
    sources: ["camera", "screen"] as const,
    camera: { maxHeight: 720, maxFps: 30 },
    screen: { maxHeight: 1080, maxFps: 15 },
  };
  it("carries a ceiling only for a source the grant actually names", () => {
    const options = videoOptionsFor({ ...grant, sources: ["screen"] }, true);
    assert.equal(options.camera, null);
    assert.deepEqual(options.screen, { maxHeight: 1080, maxFps: 15 });
  });
  it("is entirely empty for no grant at all -- the flag being off", () => {
    const options = videoOptionsFor(null, true);
    assert.deepEqual(options, { codec: "h264", camera: null, screen: null });
  });
  it("applies the person's tier to the camera and never to the screen", () => {
    const options = videoOptionsFor(grant, true, "standard");
    assert.deepEqual(options.camera, { maxHeight: 360, maxFps: 30 });
    assert.deepEqual(options.screen, { maxHeight: 1080, maxFps: 15 });
  });
});

describe("connectFailureClosesShell", () => {
  it("leaves a call that is not this connect's alone", () => {
    assert.equal(connectFailureClosesShell("already_connected"), false);
  });
  it("tidies up after any other refusal", () => {
    assert.equal(connectFailureClosesShell("connect_failed"), true);
    assert.equal(connectFailureClosesShell("cancelled"), true);
    assert.equal(connectFailureClosesShell(null), true);
  });
});

describe("defaultInputId", () => {
  const list = (...ids: string[]) => ids.map((deviceId) => ({ deviceId }));
  it("takes the default a shell reports outright", () => {
    assert.equal(
      defaultInputId({ inputs: list("a", "b"), defaultInput: "b", firstIsDefault: false }),
      "b",
    );
  });
  it("takes an entry named default (Chromium, the macOS shell)", () => {
    assert.equal(defaultInputId({ inputs: list("a", "default"), firstIsDefault: true }), "default");
    assert.equal(defaultInputId({ inputs: list("a", "default"), firstIsDefault: false }), "default");
  });
  it("takes the first where the first is the default (Safari, Firefox)", () => {
    assert.equal(defaultInputId({ inputs: list("x", "y"), firstIsDefault: true }), "x");
  });
  it("says it cannot tell rather than guessing (the Windows shell)", () => {
    assert.equal(defaultInputId({ inputs: list("x", "y"), firstIsDefault: false }), null);
    assert.equal(
      defaultInputId({ inputs: list("x"), defaultInput: null, firstIsDefault: false }),
      null,
    );
  });
  it("never answers a blank id (enumeration before a permission grant)", () => {
    assert.equal(defaultInputId({ inputs: list(""), firstIsDefault: true }), null);
    assert.equal(defaultInputId({ inputs: [], firstIsDefault: true }), null);
  });
});

describe("publishErrorMessage", () => {
  it("names the SFU's refusal rather than showing a spinner", () => {
    // The SFU refuses a source the token lacks by failing the PUBLISH, not
    // the join -- the call is already up and audible by then.
    const error = new Error("insufficient permissions to publish track source camera");
    assert.equal(
      publishErrorMessage(error, "camera"),
      "This call does not allow camera video.",
    );
  });
  it("tells a refused camera from a cancelled screen picker", () => {
    const refused = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    assert.equal(publishErrorMessage(refused, "camera"), "Camera access was refused.");
    assert.equal(
      publishErrorMessage(refused, "screen"),
      "Screen sharing was refused or cancelled.",
    );
  });
  it("has a sentence for anything it does not recognise", () => {
    assert.equal(publishErrorMessage("boom", "camera"), "The camera could not be started.");
    assert.equal(publishErrorMessage("boom", "screen"), "The screen could not be shared.");
  });
});

describe("screenOptionsFor", () => {
  const grant = { maxHeight: 1080, maxFps: 15 };
  it("leaves a small call alone", () => {
    assert.deepEqual(screenOptionsFor(grant, 2), grant);
    assert.deepEqual(screenOptionsFor(grant, SCREEN_AUDIENCE_STEP), grant);
  });
  it("drops one height step past the audience threshold, never the frame rate", () => {
    // The frame rate is the cap that bounds the worst case (a video playing
    // in a shared window), so it survives the step: what a big audience
    // multiplies is the per-viewer bitrate, and height is what carries it.
    assert.deepEqual(screenOptionsFor(grant, SCREEN_AUDIENCE_STEP + 1), {
      maxHeight: 720,
      maxFps: 15,
    });
    assert.deepEqual(screenOptionsFor({ maxHeight: 720, maxFps: 15 }, 40), {
      maxHeight: 360,
      maxFps: 15,
    });
  });
  it("has nowhere to step from the bottom rung", () => {
    assert.deepEqual(screenOptionsFor({ maxHeight: 360, maxFps: 15 }, 500), {
      maxHeight: 360,
      maxFps: 15,
    });
  });
  it("is null for a grant that does not carry a screen", () => {
    assert.equal(screenOptionsFor(null, 2), null);
  });
});

describe("tileRect", () => {
  const viewport = { width: 1000, height: 800 };

  it("clips to the viewport when the tile has no scroller", () => {
    const out = tileRect({ x: 900, y: 700, width: 200, height: 200 }, null, viewport);
    assert.deepEqual(out.clip, { x: 0, y: 0, width: 1000, height: 800 });
    assert.equal(out.visible, true);
  });

  it("clips to the scroller, which is itself clipped to the viewport", () => {
    const scroller = { x: 0, y: 100, width: 1000, height: 900 };
    const out = tileRect({ x: 10, y: 120, width: 300, height: 170 }, scroller, viewport);
    assert.deepEqual(out.clip, { x: 0, y: 100, width: 1000, height: 700 });
    // The frame is passed through untouched: the shell offsets it inside
    // the clip, so a tile half under the header stays half under it.
    assert.deepEqual(out.frame, { x: 10, y: 120, width: 300, height: 170 });
    assert.equal(out.visible, true);
  });

  it("is not visible when scrolled entirely out of its clip", () => {
    const scroller = { x: 0, y: 100, width: 1000, height: 600 };
    assert.equal(tileRect({ x: 10, y: 720, width: 300, height: 170 }, scroller, viewport).visible, false);
    assert.equal(tileRect({ x: 10, y: -200, width: 300, height: 170 }, scroller, viewport).visible, false);
  });

  it("is not visible with no area, or with a clip off screen", () => {
    assert.equal(tileRect({ x: 10, y: 10, width: 0, height: 0 }, null, viewport).visible, false);
    const gone = { x: 0, y: 900, width: 1000, height: 100 };
    assert.equal(tileRect({ x: 10, y: 910, width: 300, height: 50 }, gone, viewport).visible, false);
  });
});

describe("volumeKey", () => {
  it("keeps a person's voice and their shared audio apart", () => {
    // The whole point: one person, two independent gains. If these ever
    // collide, turning a colleague down silences the film they are sharing.
    assert.notEqual(volumeKey("u1", "microphone"), volumeKey("u1", "screen"));
  });

  it("is stable per person and kind, so a volume set early replays later", () => {
    assert.equal(volumeKey("u1", "microphone"), volumeKey("u1", "microphone"));
    assert.notEqual(volumeKey("u1", "microphone"), volumeKey("u2", "microphone"));
  });
});

describe("screen share audio", () => {
  it("captures with every processing switch off", () => {
    // A requirement, not a preference: the canceller, suppressor and gain
    // control are tuned for a voice in a room and mangle music, and there
    // is no echo path to model on audio that never went through a speaker.
    const capture = screenAudioCapture();
    assert.equal(capture.echoCancellation, false);
    assert.equal(capture.noiseSuppression, false);
    assert.equal(capture.autoGainControl, false);
    assert.equal(capture.channelCount, 2);
  });

  it("asks for the browser's own output to be left out of the capture", () => {
    // Requirement 3 on the webview path: without it a share from a Chromium
    // browser returns the far end their own voice (row S-01). Honoured on
    // Windows 11 (row S-01b), ignored everywhere else.
    assert.equal(screenAudioCapture().restrictOwnAudio, true);
  });

  it("publishes without the speech tricks that ruin music", () => {
    const publish = screenAudioPublish();
    // dtx stops sending during silence -- free on speech, audible clipping
    // on a soundtrack's quiet passages.
    assert.equal(publish.dtx, false);
    // red is redundancy for a voice on a lossy link; overhead here.
    assert.equal(publish.red, false);
    assert.equal(publish.forceStereo, true);
    assert.equal(publish.maxBitrate, SCREEN_AUDIO_BITRATE);
  });

  it("asks for far more bitrate than a voice does", () => {
    // The room's own audio ceiling is a speech number; this must not
    // silently inherit it. 128 kbps is AudioPresets.musicHighQualityStereo,
    // mirrored by hand because this file imports no SDK.
    assert.equal(SCREEN_AUDIO_BITRATE, 128_000);
    assert.ok(SCREEN_AUDIO_BITRATE > 64_000);
  });
});

describe("screenSourceKind", () => {
  it("reads the kind off the prefix the shell hands out", () => {
    assert.equal(screenSourceKind("screen:0"), "screen");
    assert.equal(screenSourceKind("window:1180440"), "window");
  });

  it("refuses an id from nowhere rather than guessing", () => {
    // Guessing "screen" would capture the whole desktop's sound for
    // somebody who asked for one window, which is the one mistake this
    // prefix exists to make impossible.
    assert.equal(screenSourceKind(""), null);
    assert.equal(screenSourceKind("0"), null);
    assert.equal(screenSourceKind(":0"), null);
    assert.equal(screenSourceKind("display:0"), null);
    assert.equal(screenSourceKind("screen:"), null);
    assert.equal(screenSourceKind("screen:abc"), null);
  });
});

describe("screenAudioMode", () => {
  it("includes a window's own process tree", () => {
    // Measured following a browser into the child process that actually
    // renders its audio (regression row S-05, run 3).
    assert.equal(screenAudioMode("window:1180440"), "include-target");
  });

  it("excludes ours when the whole screen is shared", () => {
    // Requirement 3: a clean digital copy of the far end must not go back
    // to them. Our own output measured at the floor, 0.8 dB against a
    // 110 dB self-test (S-05, run 2).
    assert.equal(screenAudioMode("screen:0"), "exclude-self");
  });

  it("treats an unreadable id as the safer of the two", () => {
    // Not "include-target": a target we could not parse has no pid to
    // include, and the exclusion is the mode that can never carry the
    // call back to the far end.
    assert.equal(screenAudioMode("nonsense"), "exclude-self");
  });
});

describe("screenAudioNote", () => {
  it("says something different for a window than for a screen", () => {
    const window = screenAudioNote("window:5");
    const screen = screenAudioNote("screen:0");
    assert.notEqual(window, screen);
    // Both must promise the call is left out -- that is the requirement
    // the sentence is reporting, in each mode's own words.
    assert.match(window, /not the call/);
    assert.match(screen, /except this call/);
  });

  it("keeps the wording paired with the mode it describes", () => {
    // The failure this guards is the two drifting apart: a note claiming
    // "this app's sound and nothing else" over an exclude-self capture.
    for (const id of ["window:1", "screen:1", "rubbish"]) {
      const mentionsOneApp = /this app's sound/.test(screenAudioNote(id));
      assert.equal(mentionsOneApp, screenAudioMode(id) === "include-target");
    }
  });
});

describe("roomProbeUrl", () => {
  it("asks the SFU the token names, over HTTP, at rtc/validate", () => {
    assert.equal(
      roomProbeUrl("wss://voice.wherry.app", "tok"),
      "https://voice.wherry.app/rtc/validate?access_token=tok",
    );
    // The rig and the dev stack: ws://localhost:7880.
    assert.equal(
      roomProbeUrl("ws://localhost:7880", "tok"),
      "http://localhost:7880/rtc/validate?access_token=tok",
    );
  });

  it("keeps a path the SFU is served under, as livekit-client does", () => {
    assert.equal(
      roomProbeUrl("wss://example.test/livekit/", "t"),
      "https://example.test/livekit/rtc/validate?access_token=t",
    );
    assert.equal(
      roomProbeUrl("wss://example.test/livekit", "t"),
      "https://example.test/livekit/rtc/validate?access_token=t",
    );
  });

  it("drops a query the URL came with and encodes the token", () => {
    assert.equal(
      roomProbeUrl("wss://example.test/?x=1", "a+b/c="),
      "https://example.test/rtc/validate?access_token=a%2Bb%2Fc%3D",
    );
  });

  it("answers nothing for a URL that is not an SFU's", () => {
    assert.equal(roomProbeUrl("not a url", "t"), null);
    assert.equal(roomProbeUrl("file:///etc/passwd", "t"), null);
  });
});

describe("roomProbeVerdict", () => {
  it("reads the SFU's own sentence as a room that is gone", () => {
    assert.equal(roomProbeVerdict(404, "requested room does not exist"), "gone");
    assert.equal(roomProbeVerdict(404, "requested room does not exist\n"), "gone");
  });

  it("does not read any other 404 as a dead room", () => {
    // An SFU without the path, or a proxy in front of one: ending a call on
    // that would end calls that are fine.
    assert.equal(roomProbeVerdict(404, "404 page not found"), "unknown");
    assert.equal(roomProbeVerdict(404, ""), "unknown");
  });

  it("tells a live room and a refused token apart from both", () => {
    assert.equal(roomProbeVerdict(200, "success"), "present");
    assert.equal(roomProbeVerdict(401, "invalid token"), "refused");
    assert.equal(roomProbeVerdict(403, ""), "refused");
    assert.equal(roomProbeVerdict(503, "requested room does not exist"), "unknown");
  });
});

describe("disconnectWasTold", () => {
  it("knows the reasons somebody else already reported", () => {
    // livekit-client's spelling and the Rust SDK's Debug spelling.
    for (const reason of [
      "PARTICIPANT_REMOVED",
      "ParticipantRemoved",
      "ROOM_DELETED",
      "RoomDeleted",
      "ROOM_CLOSED",
      "DUPLICATE_IDENTITY",
      "CLIENT_INITIATED",
      "ClientInitiated",
    ]) {
      assert.equal(disconnectWasTold(reason), true, reason);
    }
  });

  it("asks about everything else, the SFU restart's reasons included", () => {
    // The rig's SFU restart ended the native call with UnknownReason. A
    // graceful stop says ServerShutdown while the SFU is still stopping, so
    // the room's fate is unknown at that moment too (roomFollowUpStep keeps
    // asking, and does not believe an early "present" after it).
    for (const reason of [
      null,
      undefined,
      "",
      "UnknownReason",
      "UNKNOWN_REASON",
      "ServerShutdown",
      "SERVER_SHUTDOWN",
      "SignalClose",
      "JoinFailure",
      "ConnectionTimeout",
      "something new",
    ]) {
      assert.equal(disconnectWasTold(reason), false, String(reason));
    }
  });
});

describe("disconnectSfuStopping", () => {
  it("reads a server shutdown in either SDK's spelling", () => {
    assert.equal(disconnectSfuStopping("SERVER_SHUTDOWN"), true);
    assert.equal(disconnectSfuStopping("ServerShutdown"), true);
  });

  it("reads nothing else as the SFU stopping", () => {
    for (const reason of [null, undefined, "", "UnknownReason", "SignalClose", "ROOM_DELETED"]) {
      assert.equal(disconnectSfuStopping(reason), false, String(reason));
    }
  });
});

describe("transportEndFor", () => {
  const endpoint = { url: "wss://voice.wherry.app", token: "tok" };

  it("hands the session the endpoint when nobody was told", () => {
    assert.deepEqual(transportEndFor("UnknownReason", endpoint), {
      roomGone: false,
      unsettled: { endpoint, sfuStopping: false },
    });
    assert.deepEqual(transportEndFor(null, endpoint), {
      roomGone: false,
      unsettled: { endpoint, sfuStopping: false },
    });
    assert.deepEqual(transportEndFor("SERVER_SHUTDOWN", endpoint), {
      roomGone: false,
      unsettled: { endpoint, sfuStopping: true },
    });
  });

  it("leaves nothing to ask after a reason somebody already reported", () => {
    assert.deepEqual(transportEndFor("ParticipantRemoved", endpoint), { roomGone: false, unsettled: null });
    assert.deepEqual(transportEndFor("CLIENT_INITIATED", endpoint), { roomGone: false, unsettled: null });
  });

  it("has nothing to hand over without an endpoint, and never says gone itself", () => {
    assert.deepEqual(transportEndFor("UnknownReason", null), { roomGone: false, unsettled: null });
  });
});

describe("roomFollowUpStep", () => {
  it("leaves on gone, whenever it comes", () => {
    assert.equal(roomFollowUpStep("gone", 0, false), "leave");
    assert.equal(roomFollowUpStep("gone", ROOM_FOLLOW_UP_FOR_MS, true), "leave");
  });

  it("keeps asking an SFU it cannot reach, for a bounded time", () => {
    // Both clients used up their retries while the SFU was down, so the
    // first question after the end goes unanswered (review, 2026-09-27).
    assert.equal(roomFollowUpStep("unknown", 0, false), "again");
    assert.equal(roomFollowUpStep("unknown", 60_000, false), "again");
    const last = ROOM_FOLLOW_UP_FOR_MS - ROOM_FOLLOW_UP_EVERY_MS;
    assert.equal(roomFollowUpStep("unknown", last, false), "again");
    assert.equal(roomFollowUpStep("unknown", last + 1, false), "stop");
    assert.equal(roomFollowUpStep("unknown", ROOM_FOLLOW_UP_FOR_MS * 2, false), "stop");
  });

  it("stops at a room that is there, unless the SFU said it was stopping", () => {
    assert.equal(roomFollowUpStep("present", 0, false), "stop");
    // A forced stop's leave arrives while the SFU still holds the room; the
    // restart that follows forgets it.
    assert.equal(roomFollowUpStep("present", 0, true), "again");
    assert.equal(roomFollowUpStep("present", ROOM_FOLLOW_UP_FOR_MS, true), "stop");
  });

  it("stops on a refused token, which no later answer can change", () => {
    assert.equal(roomFollowUpStep("refused", 0, false), "stop");
    assert.equal(roomFollowUpStep("refused", 0, true), "stop");
  });
});
