// The invite form's choices and defaults, and how a listed link reads.
//
// Why defaults matter here: in a readable hub (public or invite-only) a link
// is the whole gate, and a member is served the channels' entire backlog. A
// link that is forwarded or leaks therefore hands whoever holds it every
// message ever posted, for as long as it keeps working. So a new link is
// bounded by default (7 days, 10 uses), and "never" and "unlimited" stay
// available as a deliberate choice that the form warns about.
//
// The bound is a client default, not a server rule, on purpose: the server
// reads an absent `expiresInSeconds` / `maxUses` as never / unlimited, and an
// installed older client relies on that, so the server cannot change what
// absent means (the server tolerates an older client).

import type { HubInvite } from "../api/types";

export type InviteChoice = { value: string; label: string };

/** Seconds as a string, "0" meaning never. */
export const INVITE_EXPIRY_CHOICES: readonly InviteChoice[] = [
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "0", label: "Never expires" },
];

/** A count as a string, "0" meaning unlimited. */
export const INVITE_USE_CHOICES: readonly InviteChoice[] = [
  { value: "1", label: "1 use" },
  { value: "10", label: "10 uses" },
  { value: "25", label: "25 uses" },
  { value: "0", label: "Unlimited uses" },
];

export const DEFAULT_INVITE_EXPIRY = "604800";
export const DEFAULT_INVITE_USES = "10";

/** The body for `POST /hubs/:id/invites`. "0" (or anything not a positive
 *  integer) is left out, which the server reads as never / unlimited. */
export function inviteRequest(
  expiry: string,
  uses: string,
): { expiresInSeconds?: number; maxUses?: number } {
  const expiresInSeconds = Number.parseInt(expiry, 10);
  const maxUses = Number.parseInt(uses, 10);
  return {
    ...(expiresInSeconds > 0 ? { expiresInSeconds } : {}),
    ...(maxUses > 0 ? { maxUses } : {}),
  };
}

/** Whether the form's current choice makes a link with no end: no expiry,
 *  no use limit, or neither. */
export function choiceIsUnbounded(expiry: string, uses: string): boolean {
  const body = inviteRequest(expiry, uses);
  return body.expiresInSeconds === undefined || body.maxUses === undefined;
}

export type InviteState = "live" | "expired" | "used_up";

type InviteLimits = Pick<HubInvite, "expiresAt" | "maxUses" | "useCount">;

/** Mirrors the redeem query in `server/src/services/hubs.ts`: a link works
 *  while `expires_at` is null or in the future and `use_count < max_uses`.
 *  The listing returns every link not revoked, dead ones included, so the
 *  list has to say which are dead. Expiry wins when both apply. */
export function inviteState(invite: InviteLimits, now: number): InviteState {
  if (invite.expiresAt !== null && Date.parse(invite.expiresAt) <= now) {
    return "expired";
  }
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return "used_up";
  }
  return "live";
}

/** A live link that only revoking will stop. Flagged in the list so old
 *  open-ended links get noticed rather than forgotten. */
export function inviteIsUnbounded(invite: InviteLimits, now: number): boolean {
  return (
    inviteState(invite, now) === "live" &&
    (invite.expiresAt === null || invite.maxUses === null)
  );
}

/** The line under a listed link. `formatDate` is injected so tests do not
 *  depend on the machine's locale. */
export function inviteDetail(
  invite: InviteLimits,
  now: number,
  formatDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleDateString(),
): string {
  const uses =
    invite.maxUses === null
      ? `${invite.useCount} ${invite.useCount === 1 ? "join" : "joins"}, no use limit`
      : `${invite.useCount}/${invite.maxUses} uses`;
  switch (inviteState(invite, now)) {
    case "expired":
      return `Expired ${formatDate(invite.expiresAt as string)} · ${uses}`;
    case "used_up":
      return `Used up · ${uses}`;
    case "live":
      return invite.expiresAt === null
        ? `${uses} · never expires`
        : `${uses} · expires ${formatDate(invite.expiresAt)}`;
  }
}
