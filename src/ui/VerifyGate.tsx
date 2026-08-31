// The screen between a session and the app, for an account whose email is
// not yet confirmed.
//
// Almost every route requires a verified address now (requireVerifiedEmail
// on the server); the exceptions are this screen's own machinery -- /auth/me,
// the two email endpoints, and logout. So there is no partial "you're in, but
// some things don't work" state to render: it is this screen or the app.
//
// The stored session's `emailVerified` is a snapshot from the last login or
// register, and verifying happens by clicking a link that arrives out of
// band -- often in another tab, sometimes on another device entirely. This
// screen is what notices: it re-checks `GET /auth/me` on mount, on an
// interval, and whenever the tab regains focus, and hands the caller an
// updated session the moment the server agrees the address is confirmed.

import { useCallback, useEffect, useState } from "react";
import { ApiError, me, resendVerification, setEmail } from "../api/client";
import { markEmailVerified } from "../api/session";
import type { StoredSession } from "../api/session";
import { AuthShell, Button, Input } from "./kit";

// Frequent enough that finishing verification in another tab feels immediate
// without switching back, cheap enough that it costs nothing sitting idle --
// this is one request against an indexed lookup, not a poll loop moving data.
const RECHECK_INTERVAL_MS = 20_000;

export function VerifyGate({
  session,
  onVerified,
  onSignOut,
}: {
  session: StoredSession;
  onVerified: (session: StoredSession) => void;
  onSignOut: () => void;
}) {
  const [email, setEmailField] = useState("");
  // Not seeded from the stored session -- that snapshot predates whatever
  // /account/email calls have happened since, including ones from this very
  // screen. `recheck` below fills it in from the server on mount.
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const result = await me();
      setCurrentEmail(result.email);
      if (result.emailVerified) {
        onVerified(markEmailVerified(session));
      }
    } catch {
      // Silent: this runs on a timer and on focus, and a transient failure
      // should not interrupt someone reading the screen. The next tick or the
      // manual button tries again.
    } finally {
      setChecking(false);
    }
  }, [onVerified, session]);

  useEffect(() => {
    void recheck();
    const interval = setInterval(() => void recheck(), RECHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };

    function onVisible() {
      if (document.visibilityState === "visible") void recheck();
    }
  }, [recheck]);

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await setEmail(email.trim());
      setCurrentEmail(email.trim());
      // Same non-disclosure the settings screen relies on: this 204s whether
      // or not the address was actually attached to this account, so the
      // message that follows has to be true in both cases.
      setNotice(
        "If that address is available, a confirmation link is on its way.",
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not reach the server.",
      );
    } finally {
      setSending(false);
    }
  }

  async function resend() {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await resendVerification();
      setNotice("Confirmation link sent again.");
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "NO_EMAIL"
          ? "There is no address on this account yet. Add one below."
          : caught instanceof ApiError
            ? caught.message
            : "Could not reach the server.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <AuthShell>
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Confirm your email
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {currentEmail
              ? `We sent a confirmation link to ${currentEmail}. Open it to continue.`
              : "This account needs a confirmed email address before it can send or receive anything."}
          </p>
        </div>

        {notice && (
          <p className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            {notice}
          </p>
        )}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {currentEmail && (
          <Button
            type="button"
            disabled={sending}
            onClick={() => void resend()}
            className="w-full"
          >
            Resend the link
          </Button>
        )}

        <form onSubmit={submitEmail} className="space-y-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {currentEmail ? "Use a different address" : "Email"}
            </span>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmailField(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={sending || !email.trim()}
            className="w-full"
          >
            {currentEmail ? "Send to this address instead" : "Send confirmation link"}
          </Button>
        </form>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            disabled={checking}
            onClick={() => void recheck()}
            className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            {checking ? "Checking…" : "I've confirmed it — check again"}
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            Sign out
          </button>
        </div>
    </AuthShell>
  );
}
