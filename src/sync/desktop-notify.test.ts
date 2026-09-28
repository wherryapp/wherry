import { test } from "node:test";
import assert from "node:assert/strict";
import { callNotificationId } from "./desktop-notify";

const CALL_A = "01927a3c-5b2e-7c41-9a0d-3f6e8b1c2d4e";
const CALL_B = "01927a3c-5b2e-7c41-9a0d-3f6e8b1c2d4f";

test("a ring's notification id is the same for the same call, so its close finds it", () => {
  assert.equal(callNotificationId(CALL_A), callNotificationId(CALL_A));
  assert.notEqual(callNotificationId(CALL_A), callNotificationId(CALL_B));
});

test("a ring's notification id fits the plugin's i32 and is never negative", () => {
  for (const callId of [CALL_A, CALL_B, "", "x", "ffffffff-ffff-7fff-bfff-ffffffffffff"]) {
    const id = callNotificationId(callId);
    assert.ok(Number.isInteger(id), `${callId}: ${id}`);
    assert.ok(id >= 0 && id <= 0x7fffffff, `${callId}: ${id}`);
  }
});
