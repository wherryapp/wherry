// The readout behind the bar's "Details": where the sound is, in four
// places -- this microphone, the uplink, each peer's downlink, and the
// key. Built for the first device pass, where "no sound from the phone"
// could not be narrowed from the bar alone; with this open on both ends
// a silent call names its own failing hop. Numbers are deltas over the
// sampling interval where a delta is what matters (bytes, packets,
// failed frames), because a total says nothing about now.
//
// Nothing here is sent anywhere. It reads the room this device already
// holds and the browser's own RTP statistics.

import { useVoiceDiagnostics } from "../../voice/hooks";
import { micLine, peerFlow, peerFlowLine } from "../../voice/rules";
import type { VoiceDiagnostics } from "../../voice/session";

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

function plus(value: number | null, unit: string): string {
  if (value === null) return "…";
  return `+${Math.round(value).toLocaleString()} ${unit}`;
}

/** A tiny level bar: 0..1 as the SFU reports it. */
function Level({ value }: { value: number }) {
  const width = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className="inline-block h-2 w-16 overflow-hidden rounded bg-neutral-200 align-middle dark:bg-neutral-700"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-label="Signal level"
    >
      <span className="block h-full bg-emerald-500" style={{ width: `${width}%` }} />
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-2">
      <dt className="truncate font-medium text-neutral-700 dark:text-neutral-200">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function transformName(transform: VoiceDiagnostics["transform"]): string {
  switch (transform) {
    case "encoded-streams":
      return "encoded streams";
    case "script-transform":
      return "script transform";
    case "none":
      return "unsupported here";
  }
}

export function CallDetails() {
  const { current, previous } = useVoiceDiagnostics(true);
  if (!current) {
    return <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Reading…</p>;
  }
  const packetsDelta = delta(current.packetsSent, previous?.packetsSent ?? null);
  const errorsDelta = previous ? current.encryptionErrors - previous.encryptionErrors : 0;

  return (
    <dl className="mt-2 grid gap-1 text-xs text-neutral-600 dark:text-neutral-300">
      <Row label="Microphone">
        {micLine(current.mic, packetsDelta)} <Level value={current.micLevel} />{" "}
        {current.packetsSent !== null && (
          <span className="text-neutral-500 dark:text-neutral-400">
            {plus(packetsDelta, "packets")}
            {current.roundTripMs !== null && ` · ${current.roundTripMs} ms round trip`}
          </span>
        )}
      </Row>

      {current.peers.length === 0 && (
        <Row label="Peers">nobody else is connected</Row>
      )}
      {current.peers.map((peer) => {
        const before = previous?.peers.find((p) => p.identity === peer.identity);
        const flow = peerFlow({
          bytesDelta: delta(peer.bytesReceived, before?.bytesReceived ?? null),
          energyDelta: delta(peer.audioEnergy, before?.audioEnergy ?? null),
          encryptionErrorsDelta: errorsDelta,
          playing: peer.playing,
        });
        return (
          <Row key={peer.identity} label={peer.name}>
            {peerFlowLine(flow)} <Level value={peer.level} />{" "}
            <span className="text-neutral-500 dark:text-neutral-400">
              {plus(delta(peer.bytesReceived, before?.bytesReceived ?? null), "bytes")}
              {peer.concealedSamples !== null &&
                ` · ${plus(delta(peer.concealedSamples, before?.concealedSamples ?? null), "concealed")}`}
              {" · "}
              {peer.encrypted ? "sealed" : "plain"}
              {peer.playing === false && " · element paused"}
            </span>
          </Row>
        );
      })}

      <Row label="Encryption">
        {current.e2ee ? (
          <>
            on, key from epoch {current.keyEpoch ?? "?"} · {current.encryptionErrors.toLocaleString()}{" "}
            frames failed
            {errorsDelta > 0 && ` (${plus(errorsDelta, "since last reading")})`}
            {current.lastEncryptionError && (
              <span className="text-neutral-500 dark:text-neutral-400">
                {" "}· last: {current.lastEncryptionError}
              </span>
            )}
          </>
        ) : (
          "off -- a public room, relayed in the clear"
        )}
      </Row>

      <Row label="Playback">
        {current.playbackBlocked ? "blocked until a tap" : "allowed"}
        {" · "}
        {current.quality === "unknown" ? "connection quality unknown" : `${current.quality} connection`}
        {" · "}
        frame transform: {transformName(current.transform)}
      </Row>
    </dl>
  );
}
