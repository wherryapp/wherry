// Whether an arriving message deserves an OS notification -- the decision
// alone, pure so it can be unit-tested without a DOM or a Tauri shell.
//
// One rule shared with the service worker's push handler (public/sw.js,
// decided 2026-08-31): a focused window means the person is inside the app,
// and the app is its own notification surface. Everything else mirrors the
// server's push filters, because a desktop notification is the webview's
// stand-in for the push the registered-but-inert service worker cannot
// deliver there: never your own message, never a muted conversation, never
// an operation or an undecryptable blob, and in a public hub channel only a
// message that mentions you (the mention-gated push rule, which exists so a
// busy public room is not a notification storm).

export type NotifyCandidate = {
  /** document.hasFocus() at the moment the batch landed. */
  windowFocused: boolean;
  /** The sender is this account (any of its devices). */
  isOwn: boolean;
  /** The payload would not decrypt; there is nothing to speak of. */
  decryptFailed: boolean;
  /** What the decoded payload is: renderable text/photo, an operation
   *  (reaction/edit/retract -- the class the send path's `silent` flag
   *  exists for), or a kind this build cannot render. */
  kind: "renderable" | "op" | "unsupported";
  /** The viewer muted this conversation. */
  muted: boolean;
  /** A public hub channel (protocol v4 delivery). */
  publicChannel: boolean;
  /** The decoded content mentions this account. */
  mentionsSelf: boolean;
};

export function shouldNotify(candidate: NotifyCandidate): boolean {
  if (candidate.windowFocused) return false;
  if (candidate.isOwn) return false;
  if (candidate.decryptFailed) return false;
  if (candidate.kind !== "renderable") return false;
  if (candidate.muted) return false;
  if (candidate.publicChannel && !candidate.mentionsSelf) return false;
  return true;
}
