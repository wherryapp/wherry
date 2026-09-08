import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cameraCeilingFor,
  connectionFromWord,
  isEncryptionFailure,
  knownDeviceId,
  micErrorName,
  nativeGainFor,
  playbackEnabledFor,
  publishErrorMessage,
  qualityFromWord,
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

describe("micErrorName", () => {
  it("maps the shell's codes onto the browser names session.ts already reads", () => {
    assert.equal(micErrorName("no_microphone"), "NotFoundError");
    assert.equal(micErrorName("permission"), "NotAllowedError");
    assert.equal(micErrorName("mic_failed"), "UnknownError");
    assert.equal(micErrorName(""), "UnknownError");
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
