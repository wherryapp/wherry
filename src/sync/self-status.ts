// This account's own manual status, held once per tab.
//
// Module-level rather than component state for the same reason ui/sending.ts
// is: two things that are not components need it -- the engine's
// notification decision (a do-not-disturb account gets no desktop toast)
// and the ring's audibility -- and both must read the same value the header
// dot shows. The server is the authority; this is a mirror, loaded on
// start, corrected by every `account` frame (another device changed it) and
// by the answer to our own change.
//
// Deliberately not persisted. A status is a fact about now; a stale one
// restored from storage would silence notifications for a state the server
// no longer holds. The load on start is one small read.

import {
  fetchAccountSettings,
  setStatus as postStatus,
  setStatusText as postStatusText,
} from "../api/client";
import { loadSession, markAvatarKey } from "../api/session";
import type { UserStatus } from "../api/types";

export type SelfStatus = {
  status: UserStatus;
  /** ISO, or null for until-changed. */
  expiresAt: string | null;
  /** The status message, or null. Lapses with `expiresAt`. */
  text: string | null;
  /** This device has gone idle (sync/idle.ts) -- shown as away on your own
   *  dot while `status` is online, the same rule the server applies. */
  idle: boolean;
  /** False until the first settings read lands, so the menu can show a
   *  neutral dot rather than claiming "online" on no evidence. */
  loaded: boolean;
};

const DEFAULT: SelfStatus = {
  status: "online",
  expiresAt: null,
  text: null,
  idle: false,
  loaded: false,
};

/** What your own dot shows: the chosen status, with idle lifting online to
 *  away -- server/src/services/presence-rules.ts's shownStatus, for one
 *  device. */
export function shownSelfStatus(self: SelfStatus): UserStatus {
  return self.status === "online" && self.idle ? "away" : self.status;
}

let current: SelfStatus = DEFAULT;
const listeners = new Set<() => void>();
let lapseTimer: ReturnType<typeof setTimeout> | undefined;
/** The read in flight, shared: every mounted useSelfStatus asks on the
 *  same `account` event, and one answer serves them all. */
let inflight: Promise<void> | null = null;

function publish(next: SelfStatus): void {
  current = next;
  if (lapseTimer !== undefined) clearTimeout(lapseTimer);
  lapseTimer = undefined;
  // A timed status lapses on the client's clock too, so the dot and the
  // DND rule flip at the moment the server's would -- without waiting for
  // the next settings read. setTimeout caps around 24.8 days; a week is
  // the schema's ceiling, so this never overflows.
  if (next.expiresAt !== null) {
    const wait = new Date(next.expiresAt).getTime() - Date.now();
    // The text lapses with the status: written beside "busy until 3", it
    // should not outlive it (presence-rules.ts's effectiveStatusText).
    if (wait <= 0) {
      current = { ...next, status: "online", expiresAt: null, text: null };
    } else {
      lapseTimer = setTimeout(() => {
        publish({ ...current, status: "online", expiresAt: null, text: null, loaded: true });
      }, wait);
    }
  }
  for (const listener of listeners) listener();
}

/** Keeps the session snapshot's `avatarKey` honest. A no-op when it already
 *  agrees, which is every refresh but the one after a change. */
function syncSessionAvatar(avatarKey: string | null): void {
  const session = loadSession();
  if (!session) return;
  if ((session.user.avatarKey ?? null) === avatarKey) return;
  markAvatarKey(session, avatarKey);
}

export const selfStatus = {
  current(): SelfStatus {
    return current;
  },

  /** Whether do-not-disturb is in force right now -- the one question the
   *  engine and the ring ask. */
  isDnd(): boolean {
    return current.status === "dnd";
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * Re-reads from the server. Called on start and on every `account` sync
   * event. Never throws: a failed read leaves the last known value, and the
   * next frame or the next start tries again -- a wrong dot for a while is
   * not worth a throw anywhere near the sync loop.
   */
  refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const settings = await fetchAccountSettings();
        // The profile picture rides along, because this read is what an
        // `account` frame triggers and the picture is one of the things
        // another device may have just changed. The header avatar draws
        // from the stored session snapshot rather than from settings, so
        // the snapshot is what has to move -- without this, choosing a
        // picture on the laptop leaves the phone showing initials until it
        // is reloaded, even though the frame arrived.
        syncSessionAvatar(settings.avatarKey ?? null);
        publish({
          ...current,
          status: settings.status ?? "online",
          expiresAt: settings.statusExpiresAt ?? null,
          text: settings.statusText ?? null,
          loaded: true,
        });
      } catch {
        // Keep what we have.
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  /**
   * Changes the status. Optimistic -- the dot flips at once -- and then
   * corrected to the server's answer, whose expiry is the one every device
   * will agree on. Throws on failure after restoring the previous value, so
   * the menu can say so.
   */
  async set(status: UserStatus, durationSeconds: number | null): Promise<void> {
    const previous = current;
    publish({
      ...current,
      status,
      expiresAt:
        status !== "online" && durationSeconds !== null
          ? new Date(Date.now() + durationSeconds * 1000).toISOString()
          : null,
      loaded: true,
    });
    try {
      const answer = await postStatus(status, durationSeconds);
      publish({
        ...current,
        status: answer.status,
        expiresAt: answer.statusExpiresAt,
        loaded: true,
      });
    } catch (error) {
      publish(previous);
      throw error;
    }
  },

  /** Sets the status message. Optimistic like `set`, restored on failure. */
  async setText(text: string | null): Promise<void> {
    const previous = current;
    const trimmed = text?.trim() || null;
    publish({ ...current, text: trimmed, loaded: true });
    try {
      const answer = await postStatusText(trimmed);
      publish({ ...current, text: answer.statusText });
    } catch (error) {
      publish(previous);
      throw error;
    }
  },

  /** sync/idle.ts's report for this device. Local only; the leader tab
   *  tells the server separately. */
  setIdle(idle: boolean): void {
    if (current.idle === idle) return;
    publish({ ...current, idle });
  },

  /** Forgets everything -- sign-out. */
  reset(): void {
    publish(DEFAULT);
  },
};
