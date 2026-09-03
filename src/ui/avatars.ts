// Profile pictures, fetched once and shared.
//
// An `<img src>` cannot carry a bearer token, and GET /users/:id/avatar needs
// one -- making the route anonymous instead was considered and rejected, since
// user ids are in every member list and an open route would hand every
// picture to anyone who has ever seen one. So the bytes are fetched like an
// attachment's and handed to the DOM as an object URL.
//
// Two things this module exists to get right, both of which a per-component
// fetch gets wrong:
//
//   * A member list draws the same person more than once, and a group draws
//     fifty people at once. One in-flight request per KEY, not per <img>.
//   * An object URL revoked while another component still points at it turns
//     that component's picture into a broken image. So the URLs are
//     reference counted here and revoked when the last holder lets go, rather
//     than in whichever component happened to unmount first.
//
// Nothing here needs invalidating: a key names one immutable picture, and
// choosing a new picture mints a new key (migration 0026).

import { downloadAvatar } from "../api/client";
import { store } from "../store";

/** The blob-cache key. Shares the store with attachments, in its own
 *  namespace -- both are "bytes we already fetched", and a second object
 *  store would be a schema bump for nothing. */
function cacheKey(avatarKey: string): string {
  return `avatar:${avatarKey}`;
}

type Held = { url: string | null; refs: number };

const held = new Map<string, Held>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * The object URL for a picture, fetching it if this is the first ask.
 *
 * Null means there is no picture under that key -- an account with none, or
 * a key that has since been replaced. That answer is terminal for the key
 * and is recorded, so nothing asks the server twice.
 *
 * Every successful acquire must be matched by exactly one `releaseAvatar`.
 */
export async function acquireAvatar(
  userId: string,
  avatarKey: string,
): Promise<string | null> {
  const existing = held.get(avatarKey);
  if (existing) {
    existing.refs += 1;
    return existing.url;
  }

  let pending = inFlight.get(avatarKey);
  if (!pending) {
    pending = load(userId, avatarKey).finally(() => inFlight.delete(avatarKey));
    inFlight.set(avatarKey, pending);
  }

  const url = await pending;

  // Re-read rather than closing over: another acquire may have created the
  // entry while this one waited, and two entries for one key would leak the
  // URL the second overwrote.
  const entry = held.get(avatarKey);
  if (entry) {
    entry.refs += 1;
    return entry.url;
  }

  held.set(avatarKey, { url, refs: 1 });
  return url;
}

/** Lets go of one acquire. The URL is revoked when the last holder does. */
export function releaseAvatar(avatarKey: string): void {
  const entry = held.get(avatarKey);
  if (!entry) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;

  if (entry.url) URL.revokeObjectURL(entry.url);
  held.delete(avatarKey);
}

async function load(userId: string, avatarKey: string): Promise<string | null> {
  const cached = await store.getBlob(cacheKey(avatarKey));
  if (cached) return cached.state === "ok" ? toUrl(cached.bytes) : null;

  let bytes: Uint8Array | null;
  try {
    bytes = await downloadAvatar(userId, avatarKey);
  } catch {
    // A network failure or a 502 is not "there is no picture", so nothing is
    // recorded and the next mount tries again. Initials in the meantime.
    return null;
  }

  if (!bytes) {
    // A 404: no picture under this key, and there never will be, since a new
    // picture is a new key. Recording it is what stops every render asking.
    await store.putBlob(cacheKey(avatarKey), { state: "unknown" });
    return null;
  }

  await store.putBlob(cacheKey(avatarKey), {
    state: "ok",
    mediaType: "image/jpeg",
    bytes,
  });
  return toUrl(bytes);
}

/** A copy, because the object URL outlives this call and a view onto a
 *  larger buffer would keep all of it alive -- Attachment.tsx's reasoning. */
function toUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(
    new Blob([bytes.slice()], { type: "image/jpeg" }),
  );
}
