import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { belowFloor, parseVersion } from "./version-floor.ts";

describe("parseVersion", () => {
  it("parses a bare X.Y.Z", () => {
    assert.deepEqual(parseVersion("0.1.0"), [0, 1, 0]);
    assert.deepEqual(parseVersion("12.34.56"), [12, 34, 56]);
  });

  it("tolerates the v prefix tags carry", () => {
    assert.deepEqual(parseVersion("v0.1.0"), [0, 1, 0]);
  });

  it("parses a git-describe suffix down to its tag", () => {
    assert.deepEqual(parseVersion("v0.1.0-5-gabc1234"), [0, 1, 0]);
    assert.deepEqual(parseVersion("0.2.0+build7"), [0, 2, 0]);
  });

  it("rejects everything that is not a version", () => {
    assert.equal(parseVersion("unknown"), null);
    assert.equal(parseVersion(""), null);
    // `git describe --always` before the first tag: a bare commit prefix.
    assert.equal(parseVersion("8a9d4ad"), null);
    assert.equal(parseVersion("0.1"), null);
    // Four segments would make "0.1.0.9" parse as 0.1.0 via the dot in the
    // suffix class -- that is accepted on purpose (it IS at least 0.1.0),
    // but garbage after a partial match is not.
    assert.equal(parseVersion("v0.x.0"), null);
  });
});

describe("belowFloor", () => {
  it("is true only strictly below the floor", () => {
    assert.equal(belowFloor("0.1.0", "0.2.0"), true);
    assert.equal(belowFloor("0.2.0", "0.2.0"), false);
    assert.equal(belowFloor("0.3.0", "0.2.0"), false);
    assert.equal(belowFloor("0.2.1", "0.2.0"), false);
    assert.equal(belowFloor("1.0.0", "0.9.9"), false);
    assert.equal(belowFloor("0.9.9", "1.0.0"), true);
  });

  it("treats a describe-suffixed build as its tag", () => {
    // Five commits past v0.1.0 is at least 0.1.0: not below a 0.1.0 floor.
    assert.equal(belowFloor("v0.1.0-5-gabc1234", "0.1.0"), false);
    assert.equal(belowFloor("v0.1.0-5-gabc1234", "0.1.1"), true);
  });

  it("fails safe on anything unparseable, either side", () => {
    assert.equal(belowFloor("unknown", "0.2.0"), false);
    assert.equal(belowFloor("0.1.0", "unknown"), false);
    assert.equal(belowFloor("0.1.0", null), false);
    assert.equal(belowFloor("0.1.0", undefined), false);
    assert.equal(belowFloor("0.1.0", ""), false);
    assert.equal(belowFloor("8a9d4ad", "0.2.0"), false);
  });
});
