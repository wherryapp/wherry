// Reloading onto a new build.
//
// `window.location.reload()` is the obvious call and the weakest one
// available: it permits the main document to come from the browser's
// in-memory page cache without revalidating. That is how a desktop browser's
// explicit reload picks up a new build while iOS Safari -- and an installed
// home-screen app on the same engine -- hands back the bundle it already had.
// Reported 2026-09-01 against the update banner, and the reason this file
// exists.
//
// Note what this is NOT working around. The service worker caches nothing at
// all (`public/sw.js` says so at length, deliberately), and Caddy serves
// index.html `no-cache` while only fingerprinted /assets/* are immutable
// (`deploy/Caddyfile`). There is no stale app shell to defeat; the document
// request simply has to happen.
//
// A *navigation* to a URL that has not been fetched before cannot be answered
// from that cache, so the reload carries a throwaway parameter. `replace`
// rather than assignment, so the reload does not add a history entry and Back
// still means what the reader expects.

const MARKER = "r";

/**
 * Where "reload onto the new build" points.
 *
 * A URL rather than an action, because the control that uses it is an
 * ANCHOR and not a button. That is deliberate and it is the second thing
 * tried on the iPhone report: a `<button onClick>` needs React's event
 * dispatch to run before anything can happen, and an `<a href>` is followed
 * by the browser itself. If the app's JavaScript is wedged, the link is the
 * only one of the two that can still get somebody out.
 *
 * It is not a cure for a pegged main thread -- a browser cannot start a
 * navigation it has no cycles to start -- but it removes one whole layer
 * from the path, and which layer was at fault is exactly what is unknown.
 */
export function updateHref(): string {
  const params = new URLSearchParams(window.location.search);
  // Base 36 purely to keep it short; nothing reads the value, it exists to
  // be different from the last one.
  params.set(MARKER, Date.now().toString(36));
  return `${window.location.pathname}?${params}`;
}

/**
 * Puts the address bar back, once the new build is running.
 *
 * `history.replaceState` rather than a second navigation -- the point was to
 * fetch the document, and that has already happened by the time this runs.
 * Every other parameter is preserved: an email verification link lands on a
 * query this must not eat, and `EmailLanding` reads the path it arrives on.
 */
export function stripReloadMarker(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(MARKER)) return;
  params.delete(MARKER);
  const query = params.size > 0 ? `?${params}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);
}
