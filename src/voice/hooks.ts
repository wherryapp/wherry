// React's view of voice: the session, the incoming rings, who is in which
// room, and the device-local preferences. Same shape as ui/hooks.ts's
// typing and presence hooks -- ephemeral state fed by sync events, with a
// self-heal read (GET /voice/active) where a lost frame would otherwise
// leave a ring showing or a room's avatars stale.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchVoiceActive } from "../api/client";
import type { Call, RoomOccupancy } from "../api/types";
import { useSyncEvents } from "../ui/hooks";
import { loadVoicePrefs, subscribeVoicePrefs, type VoicePrefs } from "./prefs";
import { reduceRings, type Ring } from "./rules";
import { voice, type VoiceDiagnostics, type VoiceState } from "./session";

/** The one session's state, re-rendered on every change. */
export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.getState, voice.getState);
}

let prefsSnapshot: VoicePrefs = loadVoicePrefs();
function readPrefs(): VoicePrefs {
  return prefsSnapshot;
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(
    (listener) =>
      subscribeVoicePrefs(() => {
        prefsSnapshot = loadVoicePrefs();
        listener();
      }),
    readPrefs,
    readPrefs,
  );
}

/** The self-heal cadence: matches the engine's conversation refresh. */
const ACTIVE_REFRESH_MS = 30_000;

/**
 * Incoming calls this device should be showing, and who is in the voice
 * rooms this account belongs to. One hook for both because they share the
 * one self-heal read; `enabled` is the feature flag (off means no read and
 * nothing shown, so a server without voice is never asked).
 */
export type OpenCall = {
  callId: string;
  status: "ringing" | "active";
  /** Users live in the call right now. */
  joinedUserIds: readonly string[];
};

export function useVoiceSignals(
  selfUserId: string,
  enabled: boolean,
): {
  rings: Ring[];
  occupancy: ReadonlyMap<string, readonly string[]>;
  /** Open ad-hoc calls by conversation id -- the "Join call" affordance. */
  openCalls: ReadonlyMap<string, OpenCall>;
  dismissRing: (callId: string) => void;
} {
  const [rings, setRings] = useState<Ring[]>([]);
  const [occupancy, setOccupancy] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const [openCalls, setOpenCalls] = useState<ReadonlyMap<string, OpenCall>>(
    () => new Map(),
  );
  const selfRef = useRef(selfUserId);
  selfRef.current = selfUserId;

  // The snapshot read: on mount, on the cadence, and whenever a ring
  // arrives (a ring's own frame is best-effort; the read confirms it).
  useEffect(() => {
    if (!enabled) {
      setRings([]);
      setOccupancy(new Map());
      setOpenCalls(new Map());
      return;
    }
    let cancelled = false;
    const load = (): void => {
      void fetchVoiceActive()
        .then((active) => {
          if (cancelled) return;
          const now = Date.now();
          setRings((previous) =>
            reduceRings(previous, {
              type: "snapshot",
              calls: active.calls,
              selfUserId: selfRef.current,
              now,
            }),
          );
          setOccupancy(toMap(active.rooms));
          setOpenCalls(toOpenCalls(active.calls));
        })
        .catch(() => {
          // A failed read leaves the last known state; the next tick retries.
        });
    };
    load();
    const timer = setInterval(load, ACTIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  useSyncEvents((event) => {
    if (!enabled) return;
    if (event.type === "call_ring") {
      if (event.byUserId === selfRef.current) return;
      setRings((previous) =>
        reduceRings(previous, {
          type: "ring",
          callId: event.callId,
          conversationId: event.conversationId,
          byUserId: event.byUserId,
          now: Date.now(),
        }),
      );
    } else if (event.type === "call_state") {
      setRings((previous) =>
        reduceRings(previous, {
          type: "state",
          callId: event.callId,
          status: event.status,
          participants: event.participants,
          selfUserId: selfRef.current,
        }),
      );
      setOpenCalls((previous) => {
        const next = new Map(previous);
        if (event.status === "ended") {
          if (next.get(event.conversationId)?.callId === event.callId) {
            next.delete(event.conversationId);
          }
        } else {
          next.set(event.conversationId, {
            callId: event.callId,
            status: event.status,
            joinedUserIds: event.participants.filter((p) => p.joined).map((p) => p.userId),
          });
        }
        return next;
      });
    } else if (event.type === "voice_presence") {
      setOccupancy((previous) => {
        const next = new Map(previous);
        if (event.occupants.length === 0) next.delete(event.conversationId);
        else next.set(event.conversationId, event.occupants);
        return next;
      });
    }
  });

  // The local backstop for a lost `ended`: a ring older than the window
  // drops on its own.
  useEffect(() => {
    if (rings.length === 0) return;
    const timer = setInterval(() => {
      setRings((previous) => reduceRings(previous, { type: "tick", now: Date.now() }));
    }, 1_000);
    return () => clearInterval(timer);
  }, [rings.length]);

  const dismiss = (callId: string): void =>
    setRings((previous) => reduceRings(previous, { type: "dismiss", callId }));

  return { rings, occupancy, openCalls, dismissRing: dismiss };
}

function toOpenCalls(calls: readonly Call[]): ReadonlyMap<string, OpenCall> {
  const map = new Map<string, OpenCall>();
  for (const call of calls) {
    if (call.kind !== "call" || call.status === "ended") continue;
    map.set(call.conversationId, {
      callId: call.id,
      status: call.status,
      joinedUserIds: call.participants
        .filter((p) => p.leftAt === null && (p.answeredAt !== null || p.joinedAt !== null))
        .map((p) => p.userId),
    });
  }
  return map;
}

function toMap(rooms: readonly RoomOccupancy[]): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const room of rooms) {
    if (room.occupants.length > 0) map.set(room.conversationId, room.occupants);
  }
  return map;
}

/** The details readout's cadence; two samples make a delta. */
const DIAGNOSTICS_INTERVAL_MS = 2_000;

export type DiagnosticsPair = {
  current: VoiceDiagnostics | null;
  previous: VoiceDiagnostics | null;
};

/**
 * Two consecutive readings of the session's diagnostics while `enabled`
 * -- the details panel is open -- and nothing otherwise. Sampling means
 * a getStats round-trip per track every two seconds, cheap but not free,
 * so it runs only while somebody is looking.
 */
export function useVoiceDiagnostics(enabled: boolean): DiagnosticsPair {
  const [pair, setPair] = useState<DiagnosticsPair>({ current: null, previous: null });
  useEffect(() => {
    if (!enabled) {
      setPair({ current: null, previous: null });
      return;
    }
    let cancelled = false;
    const tick = (): void => {
      void voice.sampleDiagnostics().then((sample) => {
        if (cancelled) return;
        setPair((last) => ({ previous: last.current, current: sample }));
      });
    };
    tick();
    const timer = setInterval(tick, DIAGNOSTICS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return pair;
}
