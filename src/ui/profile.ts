// Opening somebody's profile card, from anywhere.
//
// Every surface that shows a person -- a sender label, a member row, a
// friends row, the thread header -- can ask for the card, and the card is
// rendered exactly once, by the shell (Chat.tsx), over whatever is on
// screen. A module-level request rather than a callback threaded through
// six components, the same shape as ui/sending.ts: the alternative is a
// prop on Timeline, Bubble, GroupDetails, HubDetails, Friends and the
// sidebar for one value none of them uses themselves.
//
// The `hint` is what the opener already knows (name, handle, colour) so the
// card paints at once and the profile fetch only fills in what is new --
// the relationship and, for a friend, their status.

import { useEffect, useState } from "react";

export type ProfileHint = {
  displayName: string;
  username: string;
  avatarHue: number | null | undefined;
};

export type ProfileRequest = {
  userId: string;
  /** The element the card anchors to on a desktop; a phone shows a sheet. */
  anchor: HTMLElement | null;
  hint: ProfileHint | null;
};

let current: ProfileRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: ProfileRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function openProfile(request: ProfileRequest): void {
  publish(request);
}

export function closeProfile(): void {
  publish(null);
}

/** The shell's read: which card to show, if any. */
export function useProfileRequest(): ProfileRequest | null {
  const [value, setValue] = useState<ProfileRequest | null>(current);
  useEffect(() => {
    const listener = (): void => setValue(current);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
