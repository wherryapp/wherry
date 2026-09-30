import { Component, type ErrorInfo, type ReactNode } from "react";
import { updateHref } from "../reload";

type State = { error: Error | null };

/**
 * The one error boundary, around the whole app (main.tsx).
 *
 * Without it a throw during render unmounts React's root and leaves a blank
 * page with no way out but knowing to reload -- which on an installed phone
 * app nobody knows how to do. Sweep 1001 found a message that could do that
 * to every member of a conversation (client-core-2, since fixed at the
 * payload decoder); this is for the next one.
 *
 * Deliberately one, at the top, and deliberately plain. Finer boundaries
 * (per message, per panel) would keep more of the app standing, but each is
 * a decision about what a half-rendered screen should look like, and none
 * has been made. Only render-time throws land here: an event handler's or a
 * promise's error never reaches a boundary, and the sync loop has its own
 * handling.
 *
 * The way out is an anchor to reload.ts's cache-defeating URL, not a button:
 * on iOS an escape hatch is a link (CLAUDE.md), and this screen exists
 * exactly when the app's own code has failed. In a shell the same link
 * reloads the bundled page, which is also what is wanted there.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the whole record: there is no error store to write to
    // (diagnostics.ts measures freezes, not exceptions), and whoever reads a
    // report of this screen will ask for the console first.
    console.error("render failed; showing the error screen", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Kit `primary`'s palette at Button size="sm", plus the 44px lift a
    // finger needs -- the update banner's and VersionWall's anchor, by hand
    // for the same reason: a kit Button is a <button>.
    const actionClass =
      "inline-flex items-center justify-center rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-700 motion-safe:active:scale-[0.97] pointer-coarse:min-h-11 pointer-coarse:px-6";

    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto bg-white px-6 text-center dark:bg-neutral-950"
      >
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Something went wrong
        </h1>
        <p className="max-w-sm text-sm text-neutral-600 dark:text-neutral-400">
          The app hit an error it could not recover from. Reloading usually
          fixes it; your messages are not affected.
        </p>
        <a href={updateHref()} className={actionClass}>
          Reload
        </a>
        {error.message && (
          <p className="max-w-sm wrap-anywhere font-mono text-xs text-neutral-500 dark:text-neutral-400">
            {error.message}
          </p>
        )}
      </div>
    );
  }
}
