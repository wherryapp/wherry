import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followUpRoom, probeRoom } from "./room-probe";
import type { RoomProbeVerdict } from "./transport-rules";
import { ROOM_FOLLOW_UP_EVERY_MS, ROOM_FOLLOW_UP_FOR_MS } from "./transport-rules";

/** A follow-up on a clock that moves only when it waits: answers are handed
 *  out in order, the last one repeating. */
function scripted(answers: RoomProbeVerdict[], sfuStopping = false) {
  let clock = 0;
  let asked = 0;
  let left = 0;
  const run = followUpRoom({ url: "ws://localhost:7880", token: "tok" }, sfuStopping, {
    onGone: async () => {
      left += 1;
    },
    probe: async () => answers[Math.min(asked++, answers.length - 1)]!,
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { run, counts: () => ({ asked, left, clock }) };
}

function answering(status: number, body: string) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    return { status, text: async () => body };
  };
  return { asked, fetcher };
}

describe("probeRoom", () => {
  it("asks rtc/validate with the call's token and reads a vanished room", async () => {
    const { asked, fetcher } = answering(404, "requested room does not exist");
    assert.equal(await probeRoom("ws://localhost:7880", "tok", { fetcher }), "gone");
    assert.deepEqual(asked, ["http://localhost:7880/rtc/validate?access_token=tok"]);
  });

  it("reads a room that is still there", async () => {
    const { fetcher } = answering(200, "success");
    assert.equal(await probeRoom("wss://voice.wherry.app", "tok", { fetcher }), "present");
  });

  it("decides nothing when the SFU cannot be reached", async () => {
    const fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.equal(await probeRoom("wss://voice.wherry.app", "tok", { fetcher }), "unknown");
  });

  it("gives up on an SFU that never answers", async () => {
    const fetcher = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    assert.equal(await probeRoom("wss://voice.wherry.app", "tok", { fetcher, timeoutMs: 10 }), "unknown");
  });

  it("asks nothing for a URL it cannot turn into one", async () => {
    const { asked, fetcher } = answering(404, "requested room does not exist");
    assert.equal(await probeRoom("nonsense", "tok", { fetcher }), "unknown");
    assert.equal(asked.length, 0);
  });
});

describe("followUpRoom", () => {
  it("asks at once and leaves when the room is already gone", async () => {
    const { run, counts } = scripted(["gone"]);
    assert.equal(await run.done, "left");
    assert.deepEqual(counts(), { asked: 1, left: 1, clock: 0 });
  });

  it("outlasts an SFU that is down when the call ends, then leaves", async () => {
    // A minute of no answer (a host reboot), then the SFU is back without
    // the room: the single probe at the end used to decide nothing here.
    const down = Array.from({ length: 12 }, (): RoomProbeVerdict => "unknown");
    const { run, counts } = scripted([...down, "gone"]);
    assert.equal(await run.done, "left");
    assert.deepEqual(counts(), { asked: 13, left: 1, clock: 12 * ROOM_FOLLOW_UP_EVERY_MS });
  });

  it("stops without leaving at a room that is still there", async () => {
    const { run, counts } = scripted(["unknown", "present", "gone"]);
    assert.equal(await run.done, "stopped");
    assert.equal(counts().left, 0);
    assert.equal(counts().asked, 2);
  });

  it("does not believe a stopping SFU's early present", async () => {
    const { run, counts } = scripted(["present", "unknown", "gone"], true);
    assert.equal(await run.done, "left");
    assert.equal(counts().asked, 3);
  });

  it("gives up after its bound on an SFU that never answers", async () => {
    const { run, counts } = scripted(["unknown"]);
    assert.equal(await run.done, "stopped");
    assert.equal(counts().left, 0);
    assert.ok(counts().clock <= ROOM_FOLLOW_UP_FOR_MS);
    assert.equal(counts().asked, ROOM_FOLLOW_UP_FOR_MS / ROOM_FOLLOW_UP_EVERY_MS + 1);
  });

  it("tells nobody once cancelled, even with a gone answer in flight", async () => {
    let answer: (verdict: RoomProbeVerdict) => void = () => {};
    let left = 0;
    const run = followUpRoom({ url: "ws://localhost:7880", token: "tok" }, false, {
      onGone: async () => {
        left += 1;
      },
      probe: () => new Promise((resolve) => (answer = resolve)),
    });
    run.cancel();
    answer("gone");
    assert.equal(await run.done, "cancelled");
    assert.equal(left, 0);
  });

  it("cancels its own timer between questions", async () => {
    let left = 0;
    const run = followUpRoom({ url: "ws://localhost:7880", token: "tok" }, false, {
      onGone: async () => {
        left += 1;
      },
      probe: async () => "unknown",
    });
    // The default wait is a real 5 s timer; a cancel must end it early
    // rather than leave the test (or a page) holding it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.cancel();
    assert.equal(await run.done, "cancelled");
    assert.equal(left, 0);
  });
});
