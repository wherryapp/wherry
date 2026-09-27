import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devRelayOnly, relayRequested } from "./relay";
import { parseRoute, routeLabel, type RouteRaw } from "./route";

// Stats dictionaries shaped as the engines report them. Addresses are real
// looking on purpose: the no-address test below checks none of them leaks.
const CLIENT_IP = "192.168.1.253";
const RELAY_IP = "192.168.1.230";
const TURN_URL = "turns:turn.wherry.app:443?transport=tcp";

function local(
  id: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type: "local-candidate",
    transportId: "T01",
    address: CLIENT_IP,
    ip: CLIENT_IP,
    port: 51234,
    ...fields,
  };
}

function remote(id: string): Record<string, unknown> {
  return { id, type: "remote-candidate", address: RELAY_IP, port: 7882, protocol: "udp", candidateType: "host" };
}

function pair(
  id: string,
  localCandidateId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "candidate-pair",
    transportId: "T01",
    localCandidateId,
    remoteCandidateId: "RC",
    state: "succeeded",
    nominated: true,
    ...fields,
  };
}

/** Chromium's and WebKit's shape: the transport names its selected pair. */
function chromeReport(candidate: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { id: "OT01", type: "outbound-rtp", kind: "audio", transportId: "T01" },
    { id: "T01", type: "transport", selectedCandidatePairId: "CP1", dtlsState: "connected" },
    pair("CP1", "LC1"),
    local("LC1", candidate),
    remote("RC"),
  ];
}

function labelOf(stats: Iterable<unknown>): string {
  return routeLabel(parseRoute(stats));
}

describe("parseRoute and routeLabel: every label", () => {
  it("reads a direct UDP path", () => {
    const report = chromeReport({ candidateType: "host", protocol: "udp" });
    assert.deepEqual(parseRoute(report), {
      candidateType: "host",
      protocol: "udp",
      relayProtocol: null,
    });
    assert.equal(labelOf(report), "direct · udp");
  });

  it("counts server- and peer-reflexive candidates as direct", () => {
    assert.equal(labelOf(chromeReport({ candidateType: "srflx", protocol: "udp" })), "direct · udp");
    assert.equal(labelOf(chromeReport({ candidateType: "prflx", protocol: "udp" })), "direct · udp");
  });

  it("reads ICE-TCP to the SFU's 7881 as direct TCP", () => {
    const report = chromeReport({ candidateType: "host", protocol: "tcp", tcpType: "active" });
    assert.equal(labelOf(report), "direct · tcp");
  });

  it("reads each relay transport from relayProtocol, not from protocol", () => {
    // A relay candidate's `protocol` is the relay's leg to the SFU (UDP with
    // our coturn); the client's leg is `relayProtocol`. A label that read
    // `protocol` would call every relay "relay · udp".
    for (const via of ["udp", "tcp", "tls"] as const) {
      const report = chromeReport({ candidateType: "relay", protocol: "udp", relayProtocol: via, url: TURN_URL });
      assert.deepEqual(parseRoute(report), {
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: via,
      });
      assert.equal(labelOf(report), `relay · ${via}`);
    }
  });

  it("falls back to the ICE server URL when an engine reports no relayProtocol", () => {
    const cases: Array<[string, string]> = [
      ["turns:turn.wherry.app:443?transport=tcp", "relay · tls"],
      ["turn:turn.wherry.app:3478?transport=tcp", "relay · tcp"],
      ["turn:turn.wherry.app:3478?transport=udp", "relay · udp"],
      ["turn:192.168.1.230:13478", "relay · udp"],
    ];
    for (const [url, label] of cases) {
      assert.equal(labelOf(chromeReport({ candidateType: "relay", protocol: "udp", url })), label, url);
    }
  });

  it("says relay, and not unknown, for a relay whose transport nobody reported", () => {
    // `unknown` is what a call with no path reads (row W-112's control); a
    // relay that is working must not read the same.
    const report = chromeReport({ candidateType: "relay", protocol: "udp" });
    assert.equal(labelOf(report), "relay");
  });

  it("says relay, not a guessed transport, for a relay transport it does not recognise", () => {
    // Rows D-80, D-85 and the rest read the transport; a spelling this file
    // does not know must not be mapped onto one of the three it does.
    assert.equal(routeLabel({ candidateType: "relay", protocol: "udp", relayProtocol: "dtls" }), "relay");
    assert.equal(routeLabel({ candidateType: "relay", protocol: "tcp", relayProtocol: null }), "relay");
  });

  it("is unknown for a report with no selected pair", () => {
    const report = [
      { id: "T01", type: "transport", dtlsState: "new" },
      pair("CP1", "LC1", { state: "in-progress", nominated: false }),
      local("LC1", { candidateType: "host", protocol: "udp" }),
    ];
    assert.equal(parseRoute(report), null);
    assert.equal(labelOf(report), "unknown");
  });

  it("is unknown for an empty report, and for no route at all", () => {
    assert.equal(parseRoute([]), null);
    assert.equal(routeLabel(null), "unknown");
    assert.equal(routeLabel(undefined), "unknown");
  });

  it("is unknown for spellings it does not recognise, rather than a guess", () => {
    const odd: RouteRaw[] = [
      { candidateType: "relayed", protocol: "udp", relayProtocol: "tls" },
      { candidateType: "host", protocol: "sctp", relayProtocol: null },
      { candidateType: "host", protocol: null, relayProtocol: null },
      { candidateType: null, protocol: "udp", relayProtocol: null },
    ];
    for (const raw of odd) assert.equal(routeLabel(raw), "unknown", JSON.stringify(raw));
  });
});

describe("parseRoute: finding the selected pair", () => {
  it("reads Firefox's shape: no selectedCandidatePairId, a pair marked selected", () => {
    const report = [
      { id: "T01", type: "transport" },
      // A nominated, succeeded pair that is not the one in use comes first,
      // so the test fails if `selected` is not preferred.
      pair("CP0", "LC0"),
      pair("CP1", "LC1", { selected: true }),
      local("LC0", { candidateType: "host", protocol: "udp" }),
      local("LC1", { candidateType: "relay", protocol: "udp", relayProtocol: "tcp" }),
    ];
    assert.equal(labelOf(report), "relay · tcp");
  });

  it("falls back to a nominated, succeeded pair when nothing else names one", () => {
    const report = [
      pair("CP0", "LC0", { nominated: true, state: "in-progress" }),
      pair("CP1", "LC1", { nominated: false, state: "succeeded" }),
      pair("CP2", "LC2", { nominated: true, state: "succeeded" }),
      local("LC0", { candidateType: "relay", protocol: "udp", relayProtocol: "tls" }),
      local("LC1", { candidateType: "relay", protocol: "udp", relayProtocol: "udp" }),
      local("LC2", { candidateType: "host", protocol: "udp" }),
    ];
    assert.equal(labelOf(report), "direct · udp");
  });

  it("trusts the transport's selected pair over any other nominated pair", () => {
    const report = [
      pair("CP0", "LC0"),
      local("LC0", { candidateType: "host", protocol: "udp" }),
      { id: "T01", type: "transport", selectedCandidatePairId: "CP1" },
      pair("CP1", "LC1"),
      local("LC1", { candidateType: "relay", protocol: "udp", relayProtocol: "tls" }),
    ];
    assert.equal(labelOf(report), "relay · tls");
  });

  it("falls back when the transport names a pair the report does not hold", () => {
    const report = [
      { id: "T01", type: "transport", selectedCandidatePairId: "gone" },
      pair("CP1", "LC1", { selected: true }),
      local("LC1", { candidateType: "host", protocol: "tcp" }),
    ];
    assert.equal(labelOf(report), "direct · tcp");
  });

  it("treats an empty selectedCandidatePairId as none (the Rust SDK's serde default)", () => {
    const report = [
      { id: "T01", type: "transport", selectedCandidatePairId: "" },
      pair("CP1", "LC1"),
      local("LC1", { candidateType: "srflx", protocol: "udp" }),
    ];
    assert.equal(labelOf(report), "direct · udp");
  });

  it("uses the first transport that resolves when a report holds two", () => {
    const report = [
      { id: "T00", type: "transport", selectedCandidatePairId: "" },
      { id: "T01", type: "transport", selectedCandidatePairId: "CP1" },
      pair("CP1", "LC1"),
      local("LC1", { candidateType: "relay", relayProtocol: "udp", protocol: "udp" }),
    ];
    assert.equal(labelOf(report), "relay · udp");
  });

  it("is null when the selected pair's local candidate is missing or is not local", () => {
    assert.equal(
      parseRoute([{ id: "T01", type: "transport", selectedCandidatePairId: "CP1" }, pair("CP1", "LC1")]),
      null,
    );
    assert.equal(
      parseRoute([
        { id: "T01", type: "transport", selectedCandidatePairId: "CP1" },
        pair("CP1", "RC"),
        remote("RC"),
      ]),
      null,
    );
  });

  it("takes an RTCStatsReport's values() directly, and ignores junk entries", () => {
    const report = new Map<string, unknown>(chromeReport({ candidateType: "host", protocol: "udp" }).map((s) => [String(s["id"]), s]));
    report.set("junk", null);
    report.set("more", "not a dictionary");
    assert.equal(labelOf(report.values()), "direct · udp");
  });

  it("lowercases what it keeps, so an engine's capitalisation cannot split a label", () => {
    const report = chromeReport({ candidateType: "Relay", protocol: "UDP", relayProtocol: "TLS" });
    assert.deepEqual(parseRoute(report), { candidateType: "relay", protocol: "udp", relayProtocol: "tls" });
  });

  it("carries no address, port or URL: only the three fields", () => {
    const report = chromeReport({
      candidateType: "relay",
      protocol: "udp",
      relayProtocol: "tls",
      url: TURN_URL,
      relatedAddress: CLIENT_IP,
      relatedPort: 40000,
    });
    const raw = parseRoute(report);
    assert.ok(raw);
    assert.deepEqual(Object.keys(raw).sort(), ["candidateType", "protocol", "relayProtocol"]);
    const serialised = JSON.stringify(raw);
    for (const leak of [CLIENT_IP, RELAY_IP, "turn.wherry.app", "51234", "40000"]) {
      assert.ok(!serialised.includes(leak), `route carried ${leak}`);
    }
  });
});

describe("relayRequested (?devrelay)", () => {
  it("asks for relay-only ICE only for devrelay=1", () => {
    assert.equal(relayRequested("?devrelay=1"), true);
    assert.equal(relayRequested("?devlogin=a:b&devrelay=1&devcall=c"), true);
  });

  it("leaves ICE alone for anything else", () => {
    for (const search of ["", "?", "?devrelay", "?devrelay=0", "?devrelay=true", "?devrelay=yes", "?relay=1"]) {
      assert.equal(relayRequested(search), false, search);
    }
  });

  it("is off, and does not throw, where there is no Vite dev server", () => {
    // tsx has no `import.meta.env`; a build has `DEV: false`. Either way the
    // query string is never read.
    assert.equal(devRelayOnly(), false);
  });
});
