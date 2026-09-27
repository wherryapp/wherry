import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Call } from "../api/types";
import {
  adoptedCallStatus,
  adoptedRinging,
  decodeHandoff,
  encodeHandoff,
  orphanDecision,
  settledShellReading,
  type Handoff,
  type OrphanReading,
} from "./handoff";

const CALL: Call = {
  id: "call-1",
  conversationId: "conv-1",
  kind: "call",
  status: "active",
  startedByUserId: "user-a",
  startedAt: "2026-09-27T12:00:00.000Z",
  answeredAt: "2026-09-27T12:00:05.000Z",
  endedAt: null,
  endReason: null,
  participants: [],
};

const HANDOFF: Handoff = {
  v: 1,
  userId: "user-a",
  callId: "call-1",
  conversationId: "conv-1",
  hubVisibility: null,
  kind: "call",
  e2ee: true,
  connectedAt: 1_790_000_000_000,
  grant: null,
  call: CALL,
};

const ENDPOINT = { url: "wss://sfu.example", token: "tok" };

function orphan(overrides: Partial<OrphanReading> = {}): OrphanReading {
  return {
    handoff: encodeHandoff(HANDOFF),
    state: "connected",
    reason: null,
    endpoint: ENDPOINT,
    ...overrides,
  };
}

describe("decodeHandoff", () => {
  it("reads back what encodeHandoff wrote", () => {
    assert.deepEqual(decodeHandoff(encodeHandoff(HANDOFF)), HANDOFF);
  });

  it("keeps a hub channel's visibility and a room's kind", () => {
    const room: Handoff = { ...HANDOFF, kind: "room", hubVisibility: "public", e2ee: false, call: null };
    assert.deepEqual(decodeHandoff(encodeHandoff(room)), room);
  });

  it("is null for nothing, for junk, and for another version", () => {
    assert.equal(decodeHandoff(null), null);
    assert.equal(decodeHandoff(undefined), null);
    assert.equal(decodeHandoff(""), null);
    assert.equal(decodeHandoff("{not json"), null);
    assert.equal(decodeHandoff("[]"), null);
    assert.equal(decodeHandoff(JSON.stringify({ ...HANDOFF, v: 2 })), null);
  });

  it("is null when a field the takeover needs is missing or wrong", () => {
    for (const broken of [
      { ...HANDOFF, userId: "" },
      { ...HANDOFF, callId: 7 },
      { ...HANDOFF, conversationId: null },
      { ...HANDOFF, kind: "meeting" },
      { ...HANDOFF, e2ee: "yes" },
      { ...HANDOFF, connectedAt: "now" },
      { ...HANDOFF, hubVisibility: "secret" },
    ]) {
      assert.equal(decodeHandoff(JSON.stringify(broken)), null, JSON.stringify(broken));
    }
  });

  it("drops a call snapshot that is not this call's, and keeps the rest", () => {
    const other = { ...HANDOFF, call: { ...CALL, id: "call-2" } };
    assert.deepEqual(decodeHandoff(JSON.stringify(other)), { ...HANDOFF, call: null });
  });
});

describe("orphanDecision", () => {
  it("does nothing on an ordinary load, with no call in the shell", () => {
    assert.deepEqual(orphanDecision({ orphan: null, userId: "user-a" }), { kind: "none" });
    assert.deepEqual(orphanDecision({ orphan: null, userId: null }), { kind: "none" });
  });

  it("takes over a live call this account joined (the rig's reload, H-candidate §3.2)", () => {
    assert.deepEqual(orphanDecision({ orphan: orphan(), userId: "user-a" }), {
      kind: "adopt",
      handoff: HANDOFF,
    });
  });

  it("takes over a call that is reconnecting: the transport's watch picks it up", () => {
    const decision = orphanDecision({ orphan: orphan({ state: "reconnecting" }), userId: "user-a" });
    assert.equal(decision.kind, "adopt");
  });

  it("closes a live call it cannot take and tells the server nothing", () => {
    const drop = { kind: "drop", followUp: null };
    // Another account signed in since: its leave would close *their* row.
    assert.deepEqual(orphanDecision({ orphan: orphan(), userId: "user-b" }), drop);
    // Nobody signed in, or a page that cannot hold a call.
    assert.deepEqual(orphanDecision({ orphan: orphan(), userId: null }), drop);
    // A page that left no handoff, or one this page cannot read.
    assert.deepEqual(orphanDecision({ orphan: orphan({ handoff: null }), userId: "user-a" }), drop);
    assert.deepEqual(orphanDecision({ orphan: orphan({ handoff: "{}" }), userId: "user-a" }), drop);
  });

  it("follows up a room that ended while no page listened, as the transport would have", () => {
    assert.deepEqual(
      orphanDecision({ orphan: orphan({ state: "disconnected", reason: null }), userId: "user-a" }),
      {
        kind: "drop",
        followUp: { callId: "call-1", unsettled: { endpoint: ENDPOINT, sfuStopping: false } },
      },
    );
    const stopping = orphanDecision({
      orphan: orphan({ state: "disconnected", reason: "ServerShutdown" }),
      userId: "user-a",
    });
    assert.deepEqual(stopping, {
      kind: "drop",
      followUp: { callId: "call-1", unsettled: { endpoint: ENDPOINT, sfuStopping: true } },
    });
  });

  it("asks nothing after a disconnect somebody was told about", () => {
    const decision = orphanDecision({
      orphan: orphan({ state: "disconnected", reason: "ParticipantRemoved" }),
      userId: "user-a",
    });
    assert.deepEqual(decision, { kind: "drop", followUp: null });
  });

  it("never follows up another account's ended call, nor one without an endpoint", () => {
    assert.deepEqual(
      orphanDecision({ orphan: orphan({ state: "disconnected" }), userId: "user-b" }),
      { kind: "drop", followUp: null },
    );
    assert.deepEqual(
      orphanDecision({ orphan: orphan({ state: "disconnected", endpoint: null }), userId: "user-a" }),
      { kind: "drop", followUp: null },
    );
  });
});

describe("adoptedCallStatus", () => {
  it("is not known from nothing: the handoff's snapshot is never an input", () => {
    assert.equal(adoptedCallStatus({ heard: null, fetched: null }), null);
  });

  it("takes whichever of the two it has", () => {
    assert.equal(adoptedCallStatus({ heard: "active", fetched: null }), "active");
    assert.equal(adoptedCallStatus({ heard: null, fetched: "ringing" }), "ringing");
  });

  it("takes the later status, whichever reading arrived first", () => {
    // A status never goes back, so the later one is the newer reading.
    assert.equal(adoptedCallStatus({ heard: "active", fetched: "ringing" }), "active");
    assert.equal(adoptedCallStatus({ heard: "ringing", fetched: "active" }), "active");
    assert.equal(adoptedCallStatus({ heard: "ended", fetched: "active" }), "ended");
    assert.equal(adoptedCallStatus({ heard: "active", fetched: "ended" }), "ended");
  });
});

describe("adoptedRinging", () => {
  it("does not ring an answered call with nobody else in it now", () => {
    // A started a group call; B answered and left; C never answered. The
    // handoff's snapshot still says `ringing`; the server says active.
    assert.equal(adoptedRinging({ kind: "call", status: "active", othersInRoom: 0 }), false);
  });

  it("does not ring when the status could not be read", () => {
    assert.equal(adoptedRinging({ kind: "call", status: null, othersInRoom: 0 }), false);
  });

  it("rings a call the server still says is ringing, with nobody else in the room", () => {
    assert.equal(adoptedRinging({ kind: "call", status: "ringing", othersInRoom: 0 }), true);
    assert.equal(adoptedRinging({ kind: "call", status: "ringing", othersInRoom: 1 }), false);
    assert.equal(adoptedRinging({ kind: "room", status: "ringing", othersInRoom: 0 }), false);
  });
});

describe("settledShellReading", () => {
  function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      slept,
    };
  }

  function script(readings: { call: string | null; connecting: boolean }[]) {
    let reads = 0;
    return {
      read: async () => readings[Math.min(reads++, readings.length - 1)]!,
      reads: () => reads,
    };
  }

  it("answers at once when nothing is connecting", async () => {
    const clock = fakeClock();
    const shell = script([{ call: null, connecting: false }]);
    assert.equal(await settledShellReading(shell.read, { waitMs: 1_000, pollMs: 100, ...clock }), null);
    assert.deepEqual(clock.slept, []);
  });

  it("answers with the call when one is stored, connecting or not", async () => {
    const shell = script([{ call: "session-1", connecting: true }]);
    const got = await settledShellReading(shell.read, { waitMs: 1_000, pollMs: 100, ...fakeClock() });
    assert.equal(got, "session-1");
  });

  it("waits for a connect in flight to land (the old page's, across a reload)", async () => {
    const clock = fakeClock();
    const shell = script([
      { call: null, connecting: true },
      { call: null, connecting: true },
      { call: "session-1", connecting: false },
    ]);
    const got = await settledShellReading(shell.read, { waitMs: 1_000, pollMs: 100, ...clock });
    assert.equal(got, "session-1");
    assert.equal(shell.reads(), 3);
    assert.deepEqual(clock.slept, [100, 100]);
  });

  it("answers null when the connect it waited for failed", async () => {
    const shell = script([
      { call: null, connecting: true },
      { call: null, connecting: false },
    ]);
    const got = await settledShellReading(shell.read, { waitMs: 1_000, pollMs: 100, ...fakeClock() });
    assert.equal(got, null);
  });

  it("gives up after its wait while a connect is still in flight", async () => {
    const shell = script([{ call: null, connecting: true }]);
    const got = await settledShellReading(shell.read, { waitMs: 1_000, pollMs: 250, ...fakeClock() });
    assert.equal(got, null);
    assert.equal(shell.reads(), 5);
  });
});
