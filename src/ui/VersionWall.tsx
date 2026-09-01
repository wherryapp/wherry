// The version floor's hard stop.
//
// Shown when the server's /health reports a minimum client version this
// build is strictly below (api/version-floor.ts, fail-safe by contract).
// This is the counterpart to UpdateBanner's soft prompt, and the reason it
// is a separate component with a separate status field: the banner must
// never become a wall, and the wall must never be dismissible -- a client
// below the floor is one the server can no longer promise compatibility
// to, and letting it keep sending is how undecryptable messages and
// half-understood payloads get written.
//
// Two sources feed the decision, and both are needed:
//
//   - Its own /health fetch at mount, because the wall must also stop a
//     signed-out client (the login screen starts no sync engine) and a
//     follower tab (only the leader's loop calls #checkForUpdate).
//   - The engine's `belowMinVersion` status, so a floor raised while the
//     app sits open lands on the next poll rather than the next launch.
//
// Both fail safe the same way: no answer means no wall.

import { useEffect, useState } from "react";
import { fetchHealth } from "../api/client";
import { SHELL, openExternal, updateDestination } from "../api/shell";
import { belowFloor } from "../api/version-floor";
import { updateHref } from "../reload";
import { APP_VERSION } from "../sync/engine";
import { useSyncStatus } from "./hooks";

/**
 * Whether this build is below the server's floor, from whichever source
 * answered. `minVersion` is the floor itself when known, for the copy.
 */
export function useVersionFloor(): {
  blocked: boolean;
  minVersion: string | null;
} {
  const status = useSyncStatus();
  const [own, setOwn] = useState<{
    blocked: boolean;
    minVersion: string | null;
  }>({ blocked: false, minVersion: null });

  useEffect(() => {
    // Nothing to compare against: dev, and any build outside the pipeline.
    if (APP_VERSION === "unknown") return;
    let cancelled = false;
    void fetchHealth()
      .then((health) => {
        if (cancelled) return;
        const blocked = belowFloor(APP_VERSION, health.minVersion);
        setOwn({
          blocked,
          minVersion: blocked ? (health.minVersion ?? null) : null,
        });
      })
      .catch(() => {
        // An unreachable server is a network problem, never a wall.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    blocked: own.blocked || status.belowMinVersion,
    minVersion: own.minVersion ?? status.minVersion,
  };
}

/**
 * Full-screen, no way past by design. The action is the only interactive
 * thing on it:
 *
 *   - Web: an anchor to reload.ts's cache-defeating URL -- the same origin
 *     serves current assets, so the navigation IS the update. An anchor
 *     and not a button, per the escape-hatch-is-a-link rule (CLAUDE.md):
 *     this screen exists precisely when the app is presumed broken.
 *   - Bundled shells (desktop, iOS, Android): no reload can freshen baked
 *     assets, so the action hands the release page (later: the store
 *     listing -- api/shell.ts is the one line that changes) to the system
 *     browser via the opener plugin. A button, unavoidably: inside a
 *     webview an anchor would navigate the app itself away, which is the
 *     opposite of an escape hatch.
 */
export function VersionWall({ minVersion }: { minVersion: string | null }) {
  const destination = updateDestination();

  const heading = "This version is too old";
  const body = minVersion
    ? `The server now requires at least version ${minVersion}, and this ${
        SHELL === "web" ? "page" : "app"
      } is running ${APP_VERSION}.`
    : `The server no longer supports the version this ${
        SHELL === "web" ? "page" : "app"
      } is running (${APP_VERSION}).`;

  const actionClass =
    "inline-flex items-center justify-center rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-700 motion-safe:active:scale-[0.97] pointer-coarse:min-h-11 pointer-coarse:px-6";

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white px-6 text-center dark:bg-neutral-950">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {heading}
      </h1>
      <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
        {body} Messages stay on this device and come back once it is updated.
      </p>
      {destination.kind === "reload" ? (
        <a href={updateHref()} className={actionClass}>
          Reload with the new version
        </a>
      ) : (
        <button
          type="button"
          className={actionClass}
          onClick={() => void openExternal(destination.href).catch(() => {})}
        >
          {destination.label}
        </button>
      )}
    </div>
  );
}
