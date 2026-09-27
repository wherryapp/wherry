// Opening a conversation from outside the page: a tapped push notification
// today, the phone-calls plan's Answer later.
//
// The one "open this from outside" store (docs/prompts/native-push-plan.md
// §7.1; native-gaps-coordination.md §4). A module-level request with the
// same shape as ui/profile.ts: whoever learns that something should open
// calls `requestOpen`, and the shell (Chat.tsx) is the only reader, because
// only the shell owns the selection and the panels. The phone-calls plan's
// bridge imports `requestOpen` and adds no second store.
//
// Unlike a profile request, this one has to *wait*. A cold-start tap is
// handed over before the conversation list has loaded -- often before the
// first sync has run at all -- so the request is held until the shell
// consumes it, and the shell consumes it only once it has resolved it.
// A request older than REQUEST_TTL_MS is dropped instead of acted on: a
// tap that could not be resolved for that long (a conversation this device
// left, a ref minted for another account) must not open something minutes
// later while the person is doing something else.

import { useEffect, useState } from "react";
import type { NativeKind } from "../sync/native-push-rules";

export type OpenKind = NativeKind;

export type OpenRequest = {
  kind: OpenKind;
  /** Known when the opener has the id (a call Answer). */
  conversationId?: string;
  /** The per-device opaque reference a push carries instead of an id
   *  (native-push-rules.ts computeRef); the shell resolves it. */
  ref?: string;
  /** When it was asked for, for the staleness rule. */
  at: number;
};

export const REQUEST_TTL_MS = 2 * 60 * 1000;

let current: OpenRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: OpenRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Asks the shell to open something. A newer request replaces an older one
 * that has not been consumed: the latest tap is what the person meant.
 */
export function requestOpen(request: {
  kind: OpenKind;
  conversationId?: string;
  ref?: string;
}): void {
  console.info(
    `open-request ${request.kind}${request.conversationId ? ` ${request.conversationId}` : ""}${request.ref ? ` ref=${request.ref}` : ""}`,
  );
  publish({ ...request, at: Date.now() });
}

/**
 * The shell marks a request handled. Only the request it was handed is
 * cleared, so one that arrived in the meantime survives.
 */
export function consumeOpen(request: OpenRequest): void {
  if (current === request) publish(null);
}

/** The pending request, outside React (tests, and a caller that must know
 *  whether something is already waiting). */
export function pendingOpen(): OpenRequest | null {
  return current;
}

/** Whether a request has waited too long to be acted on. */
export function isStale(request: OpenRequest, now: number): boolean {
  return now - request.at > REQUEST_TTL_MS;
}

/** The shell's read: what to open, if anything. */
export function useOpenRequest(): OpenRequest | null {
  const [value, setValue] = useState<OpenRequest | null>(current);
  useEffect(() => {
    const listener = (): void => setValue(current);
    listeners.add(listener);
    // A request published between the first render and this effect.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
