import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectionFromWord,
  isEncryptionFailure,
  knownDeviceId,
  micErrorName,
  nativeGainFor,
  playbackEnabledFor,
  qualityFromWord,
  userIdFromMetadata,
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
