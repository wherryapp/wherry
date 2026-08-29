import { useState, type FormEvent } from "react";
import { ApiError, login, register } from "../api/client";
import { defaultDeviceName, deviceDescriptor, saveSession } from "../api/session";
import type { StoredSession } from "../api/session";

/**
 * Login and registration, which are the same form with one extra field.
 *
 * The device descriptor is built by `deviceDescriptor()`, which includes the
 * stored device id when this browser has logged in before. That is the single
 * most consequential line on this screen: omitting it creates a new device row
 * on every login and silently multiplies the envelope fan-out for everyone who
 * messages this user. See api/session.ts.
 */
export function Login({
  onSignedIn,
}: {
  onSignedIn: (session: StoredSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const device = deviceDescriptor(defaultDeviceName());
      const result =
        mode === "login"
          ? await login({ username, password, device })
          : await register({ username, displayName, password, device });

      onSignedIn(saveSession(result));
    } catch (caught) {
      // Match on the code, never the message -- docs/api.md is explicit that
      // the text is for humans and will change.
      if (caught instanceof ApiError) {
        setError(
          caught.code === "INVALID_CREDENTIALS"
            ? "That username and password do not match."
            : caught.code === "USERNAME_TAKEN"
              ? "That username is already taken."
              : caught.code === "RATE_LIMITED"
                ? "Too many attempts. Wait a few minutes and try again."
                : caught.code === "UNKNOWN_DEVICE"
                  ? "This device is no longer recognised. Clearing site data will fix it."
                  : caught.message,
        );
      } else {
        setError("Cannot reach the server.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {mode === "login" ? "Sign in" : "Create an account"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Messages are not end-to-end encrypted yet.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Username
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            pattern="[a-zA-Z0-9._\-]{3,32}"
            title="3–32 characters: letters, numbers, dot, underscore or hyphen"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>

        {mode === "register" && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Display name
            </span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={100}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={12}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            At least 12 characters.
          </span>
        </label>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          className="w-full text-sm text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
        >
          {mode === "login"
            ? "Need an account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
