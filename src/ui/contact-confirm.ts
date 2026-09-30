// The questions a destructive contact action asks, in one place.
//
// Removing a friend and blocking somebody can be done from the profile card
// and from Friends. Both ask first, in these words, so the same act is never
// guarded on one surface and not on the other (sweep 1001, client-ui-20).
// Declining a request, cancelling one's own and unblocking do not ask on
// either: each is undone by asking again.

export type ContactConfirm = { message: string; confirmLabel: string };

export function removeFriendConfirm(displayName: string): ContactConfirm {
  return {
    message: `Remove ${displayName} from your friends?`,
    confirmLabel: "Remove",
  };
}

export function blockConfirm(displayName: string): ContactConfirm {
  return {
    message: `Block ${displayName}? They will not be able to message you or find you, and will not be told.`,
    confirmLabel: "Block",
  };
}
