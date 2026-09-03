// A send that is still in flight, per conversation.
//
// ---------------------------------------------------------------------------
// Why this is not component state, and not persisted either
// ---------------------------------------------------------------------------
//
// It used to be `useState` inside the composer. Leaving the conversation
// unmounts that component, so coming back showed an empty composer with no
// sign of the upload -- which reads as "it cancelled", and was reported
// exactly that way. The work itself was never cancelled: `submit` is an async
// function whose promise keeps running after unmount, so the upload finishes
// and the message appears. Only the evidence went missing.
//
// So the state has to outlive the component. It must NOT outlive the *page*,
// though, and that is why this is a module-level map rather than something in
// IndexedDB: the XHR carrying the upload dies with the document. Restoring
// "Uploading 44%" after a reload would be describing a transfer that no
// longer exists, which is a worse lie than showing nothing. Module lifetime
// is exactly the upload's lifetime, so the two can never disagree.
//
// Keyed by conversation because two can be sending at once, and a progress
// line belongs to the thread it is uploading into.

import { useCallback, useSyncExternalStore } from "react";

import type { UploadProgress } from "./upload-status";

const inFlight = new Map<string, UploadProgress>();
const listeners = new Set<() => void>();

/**
 * Publishes where a conversation's send has got to, or clears it with null.
 *
 * Called from the send path, which may well be running inside a component
 * that has already unmounted -- that is the whole point.
 */
export function setSendProgress(
  conversationId: string,
  progress: UploadProgress | null,
): void {
  if (progress === null) {
    if (!inFlight.delete(conversationId)) return;
  } else {
    inFlight.set(conversationId, progress);
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * The in-flight send for this conversation, if there is one.
 *
 * `useSyncExternalStore` rather than state-plus-effect, for the reason
 * viewport.ts gives: the value is read fresh on every notification, so there
 * is no copy to fall out of step and no first render showing the wrong thing
 * before an effect corrects it. The snapshot is reference-stable between
 * writes -- the map holds the object, and `setSendProgress` is the only thing
 * that replaces it -- which is what stops React re-rendering forever.
 */
export function useSendProgress(conversationId: string): UploadProgress | null {
  const read = useCallback(
    () => inFlight.get(conversationId) ?? null,
    [conversationId],
  );
  return useSyncExternalStore(subscribe, read);
}
