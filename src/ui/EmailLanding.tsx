// The two screens somebody reaches from a link in an email.
//
// Rendered by path rather than by a router. The app has one screen and two
// panels; adding a routing library so that two links can be opened would be
// more machinery than the thing it serves. Caddy already falls back to
// index.html for unknown paths, so both URLs load the app.
//
// Neither screen requires a session, and that is the point. Somebody confirming
// an address is often doing it on the phone they read mail on, which may be a
// browser they have never signed in on.

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, confirmPasswordReset, verifyEmail } from "../api/client";
import { Button, ErrorText, Input } from "./kit";

export type EmailRoute =
  | { kind: "verify"; token: string }
  | { kind: "reset"; token: string };

/**
 * Which of these screens, if either, the current URL is asking for.
 *
 * Read once at startup. A missing token is treated as no route at all rather
 * than as an error page -- somebody who lands on /verify-email with nothing
 * after it is better served by the app than by a complaint.
 */
export function routeFromLocation(): EmailRoute | null {
  const { pathname, search } = window.location;
  const token = new URLSearchParams(search).get("token");
  if (!token) return null;

  if (pathname === "/verify-email") return { kind: "verify", token };
  if (pathname === "/reset-password") return { kind: "reset", token };
  return null;
}

/**
 * Puts the app back at the root without reloading it.
 *
 * The token stays in the URL otherwise, which means it survives in history, in
 * a shared screenshot, and in whatever the browser syncs -- for a code that is
 * already spent, but a reset link in a synced history is still a bad habit to
 * build.
 */
function clearUrl(): void {
  window.history.replaceState(null, "", "/");
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    // Same scroll-container fix as Login.tsx's forms -- #root is a fixed,
    // visual-viewport-sized box with no scroll of its own, so centering
    // alone leaves an unreachable bottom on anything taller than the screen.
    <div className="h-full overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          {children}
        </div>
      </div>
    </div>
  );
}

export function VerifyEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<"working" | "ok" | "failed">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void verifyEmail(token)
      .then((result) => {
        setState("ok");
        setMessage(result.email);
        clearUrl();
      })
      .catch((caught: unknown) => {
        setState("failed");
        setMessage(
          caught instanceof ApiError
            ? caught.message
            : "Could not reach the server.",
        );
        clearUrl();
      });
  }, [token]);

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        {state === "working"
          ? "Confirming…"
          : state === "ok"
            ? "Address confirmed"
            : "That link did not work"}
      </h1>

      {state === "ok" && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {message} is now confirmed. You can sign in with it and use it to
          reset your password.
        </p>
      )}

      {state === "failed" && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {message} Links expire after a day, work once, and are replaced when a
          new one is sent — so an older email in your inbox will not work.
        </p>
      )}

      {state !== "working" && (
        <Button onClick={onDone} className="w-full">
          Continue
        </Button>
      )}
    </Shell>
  );
}

export function ResetPassword({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await confirmPasswordReset(token, password);
      setDone(true);
      clearUrl();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Password changed
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Every device has been signed out, including any you did not recognise.
          Sign in again with the new password.
        </p>
        <Button onClick={onDone} className="w-full">
          Sign in
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        Choose a new password
      </h1>
      <form onSubmit={submit} className="space-y-3">
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password (at least 12 characters)"
        />
        {error && <ErrorText>{error}</ErrorText>}
        <Button type="submit" disabled={busy || password.length < 12} className="w-full">
          {busy ? "…" : "Set password"}
        </Button>
      </form>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        This signs out every device on the account.
      </p>
    </Shell>
  );
}
