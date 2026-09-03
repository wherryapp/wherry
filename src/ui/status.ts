// The words, colours and durations for a manual status -- pure, so the
// self menu, the sidebar dot, the thread header and the profile card all
// say the same thing about the same state, and so the "until tomorrow"
// arithmetic can be tested against a clock.
//
// The server side of the same rule set is server/src/services/
// presence-rules.ts; the two must agree on what the four values mean.

import type { UserStatus, VisibleStatus } from "../api/types";

export type StatusOption = {
  status: UserStatus;
  label: string;
  /** One line under the label in the picker: what choosing it does. */
  description: string;
};

/** In picker order. Online first because it is the default and the way
 *  back; invisible last because it is the one that hides. */
export const STATUS_OPTIONS: readonly StatusOption[] = [
  {
    status: "online",
    label: "Online",
    description: "Shown as online while the app is open.",
  },
  {
    status: "away",
    label: "Away",
    description: "Shown as away. Notifications still arrive.",
  },
  {
    status: "dnd",
    label: "Do not disturb",
    description: "No notifications or ringing on any of your devices.",
  },
  {
    status: "invisible",
    label: "Appear offline",
    description: "Nobody sees you online or typing. You still see everyone.",
  },
];

/** The label for a status as seen on somebody else, or on yourself. */
export function statusLabel(status: UserStatus | "offline"): string {
  switch (status) {
    case "online":
      return "Online";
    case "away":
      return "Away";
    case "dnd":
      return "Do not disturb";
    case "invisible":
      return "Appear offline";
    case "offline":
      return "Offline";
  }
}

/**
 * The dot colour for a status, as Tailwind background classes. One place,
 * so the sidebar dot, the header avatar and the picker cannot drift --
 * green for here, amber for away, red for busy, and a hollow grey for
 * appearing offline (only ever shown on yourself, since nobody else is
 * told). `offline` is no dot at all; the caller renders nothing.
 */
export function statusDotClass(status: UserStatus): string {
  switch (status) {
    case "online":
      return "bg-green-500";
    case "away":
      return "bg-amber-400";
    case "dnd":
      return "bg-red-500";
    case "invisible":
      // Hollow: the ring colour is the fill, a grey stroke the only mark.
      // This variant owns its ENTIRE look -- StatusDot must not add its
      // white/neutral-900 ring on top, or two same-specificity border
      // colours land on one element and stylesheet order decides (the
      // pointer-events lesson in CLAUDE.md, in border form; it shipped
      // invisible on dark for exactly that reason before this comment).
      return "border-2 border-neutral-400 bg-white dark:border-neutral-500 dark:bg-neutral-900";
  }
}

/** What a presence answer says about somebody in `online` -- absent from
 *  the statuses map means plain online, which is also how a frame from an
 *  older server (no map at all) reads. */
export function presenceStatusOf(
  userId: string,
  statuses: Readonly<Record<string, VisibleStatus>> | undefined,
): VisibleStatus {
  return statuses?.[userId] ?? "online";
}

/**
 * Which of a conversation's members are online, in member order, excluding
 * the caller.
 *
 * Small enough to inline and deliberately not inlined: the sidebar's group
 * dot, the member rows in Group details and the switcher all have to agree
 * about what "somebody else is here" means, and three copies of a filter is
 * how they stop agreeing. Self is excluded everywhere for the same reason
 * the DM dot never depicts you -- your own presence is the header avatar's
 * job, and counting yourself would light up every room you have open.
 *
 * An absent snapshot is unknown, never everyone-offline: presence has no
 * stored form, so a socket-down period means no dots rather than a screen
 * full of grey ones.
 */
export function onlineOthers(
  memberIds: readonly string[],
  selfUserId: string,
  online: readonly string[] | undefined,
): string[] {
  if (!online || online.length === 0) return [];
  const present = new Set(online);
  return memberIds.filter(
    (userId) => userId !== selfUserId && present.has(userId),
  );
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export type DurationChoice = "until-changed" | "30m" | "1h" | "tomorrow";

export const DURATION_OPTIONS: readonly { value: DurationChoice; label: string }[] = [
  { value: "until-changed", label: "Until I turn it off" },
  { value: "30m", label: "For 30 minutes" },
  { value: "1h", label: "For 1 hour" },
  { value: "tomorrow", label: "Until tomorrow" },
];

/** The next 08:00 local, from `now`. Morning rather than midnight, because
 *  "until tomorrow" set at 23:30 should not expire in half an hour. */
export function nextMorning(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next;
}

/**
 * The seconds the server is told, or null for until-changed. Whole seconds,
 * at least a minute (the schema's floor) -- "until tomorrow" chosen at
 * 07:59:30 asks for tomorrow's 08:00, not today's.
 */
export function durationSeconds(choice: DurationChoice, now: Date): number | null {
  switch (choice) {
    case "until-changed":
      return null;
    case "30m":
      return 30 * 60;
    case "1h":
      return 60 * 60;
    case "tomorrow":
      return Math.max(60, Math.round((nextMorning(now).getTime() - now.getTime()) / 1000));
  }
}

/** "Until 14:30" or "Until tomorrow 08:00" for the menu's fine print. */
export function expiryLabel(expiresAt: string, now: Date): string {
  const at = new Date(expiresAt);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? `Until ${time}` : `Until tomorrow ${time}`;
}
