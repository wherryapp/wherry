import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeRoom } from "./room-probe";

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
