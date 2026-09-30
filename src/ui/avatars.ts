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
//
// Since 2026-09-05 a hub's picture goes through here too (migration 0028):
// the key space is shared -- every key is a fresh uuidv7, whoever it names
// -- so the only thing that differs is which route fetches the bytes, and
// that is what the caller passes in. `acquireAvatar` is therefore keyed by
// the picture and told how to load it, rather than knowing about users.

import { store } from "../store";

/** Fetches one picture's bytes; null for "nothing under that key". A
 *  network failure throws, and is deliberately not cached (see load). */
export type AvatarLoader = () => Promise<Uint8Array | null>;

/** The blob-cache key. Shares the store with attachments, in its own
 *  namespace -- both are "bytes we already fetched", and a second object
 *  store would be a schema bump for nothing. */
function cacheKey(avatarKey: string): string {
  return `avatar:${avatarKey}`;
}

/**
 * One picture's shared answer. `failed` marks a null that is *not* "there is
 * no picture": the fetch failed (offline, a 502), so the next acquire that
 * finds it with nothing in flight tries again and fills the entry in for
 * every holder. Without it one failed fetch at startup left initials for the
 * whole session, because the header's avatar and the sidebar's rows never
 * all let go at once (sweep 1001, client-ui-15).
 */
type Held = { url: string | null; refs: number; failed: boolean };
type Loaded = { url: string | null; failed: boolean };

const held = new Map<string, Held>();
const inFlight = new Map<string, Promise<Loaded>>();

function loadOnce(avatarKey: string, loader: AvatarLoader): Promise<Loaded> {
  let pending = inFlight.get(avatarKey);
  if (!pending) {
    pending = load(avatarKey, loader).finally(() => inFlight.delete(avatarKey));
    inFlight.set(avatarKey, pending);
  }
  return pending;
}

/**
 * The object URL for a picture, fetching it if this is the first ask.
 *
 * Null means there is no picture under that key -- an account with none, or
 * a key that has since been replaced. That answer is terminal for the key
 * and is recorded, so nothing asks the server twice. A null from a failed
 * fetch is not terminal: see `Held.failed`.
 *
 * Every acquire must be matched by exactly one `releaseAvatar`. It never
 * rejects, so a caller's release is always owed and always right.
 */
export async function acquireAvatar(
  avatarKey: string,
  loader: AvatarLoader,
): Promise<string | null> {
  const existing = held.get(avatarKey);
  if (existing && !existing.failed) {
    existing.refs += 1;
    return existing.url;
  }

  if (existing) {
    // A failed entry: counted as held now, so it cannot be deleted under
    // this acquire while the retry is out.
    existing.refs += 1;
    const result = await loadOnce(avatarKey, loader);
    if (existing.failed && !result.failed) {
      existing.url = result.url;
      existing.failed = false;
    } else if (result.url && result.url !== existing.url) {
      // Another retry already filled the entry; this URL has no holder.
      URL.revokeObjectURL(result.url);
    }
    return existing.url;
  }

  const result = await loadOnce(avatarKey, loader);

  // Re-read rather than closing over: another acquire may have created the
  // entry while this one waited, and two entries for one key would leak the
  // URL the second overwrote.
  const entry = held.get(avatarKey);
  if (entry) {
    entry.refs += 1;
    if (entry.failed && !result.failed) {
      entry.url = result.url;
      entry.failed = false;
    }
    return entry.url;
  }

  held.set(avatarKey, { url: result.url, refs: 1, failed: result.failed });
  return result.url;
}

/**
 * Whether this picture's last fetch failed rather than finding nothing --
 * what a holder showing initials checks before asking again.
 */
export function avatarFailed(avatarKey: string): boolean {
  return held.get(avatarKey)?.failed ?? false;
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

async function load(avatarKey: string, loader: AvatarLoader): Promise<Loaded> {
  // A cache that cannot be read is a miss, not a failure of the picture.
  let cached: Awaited<ReturnType<typeof store.getBlob>>;
  try {
    cached = await store.getBlob(cacheKey(avatarKey));
  } catch {
    cached = undefined;
  }
  if (cached) {
    return {
      url: cached.state === "ok" ? toUrl(cached.bytes) : null,
      failed: false,
    };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await loader();
  } catch {
    // A network failure or a 502 is not "there is no picture", so nothing is
    // recorded and a later acquire tries again. Initials in the meantime.
    return { url: null, failed: true };
  }

  // The cache writes are never fatal: the answer is in hand, and a store
  // that will not keep it costs a fetch next session, not this one.
  if (!bytes) {
    // A 404: no picture under this key, and there never will be, since a new
    // picture is a new key. Recording it is what stops every render asking.
    await store
      .putBlob(cacheKey(avatarKey), { state: "unknown" })
      .catch(() => {});
    return { url: null, failed: false };
  }

  await store
    .putBlob(cacheKey(avatarKey), {
      state: "ok",
      mediaType: "image/jpeg",
      bytes,
    })
    .catch(() => {});
  return { url: toUrl(bytes), failed: false };
}

/** A copy, because the object URL outlives this call and a view onto a
 *  larger buffer would keep all of it alive -- Attachment.tsx's reasoning. */
function toUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(
    new Blob([bytes.slice()], { type: "image/jpeg" }),
  );
}
