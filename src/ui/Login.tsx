import { useState, type FormEvent } from "react";
import {
  ApiError,
  login,
  register,
  requestPasswordReset,
} from "../api/client";
import { defaultDeviceName, deviceDescriptor, saveSession } from "../api/session";
import type { StoredSession } from "../api/session";
import {
  persistKeypair,
  prepareRegistrationKeys,
  recoverWithCode,
  startFresh,
  unlockAccountKey,
} from "../crypto/account";
import { KeysError } from "../crypto/keys";
import { Button, Input } from "./kit";

/**
 * What stands between a successful auth call and entering the app.
 *
 * Registration always passes through "show-code" -- the recovery code is
 * shown exactly once, and the blocking screen is what "once" costs. Login
 * passes through "recovery" only when the password wrap failed to open,
 * which is the signature of a password reset this browser cannot repair
 * silently (see crypto/account.ts).
 */
type PostAuth =
  | { kind: "show-code"; code: string; session: StoredSession }
  | { kind: "recovery"; password: string; session: StoredSession };

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
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postAuth, setPostAuth] = useState<PostAuth | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === "forgot") {
        await requestPasswordReset(email);
        // Shown whether or not that address has an account, because the server
        // answers the same way either way. Saying "we have sent you a link"
        // would be a promise this screen cannot keep and a way to test which
        // addresses are registered.
        setSent(true);
        return;
      }

      const device = deviceDescriptor(defaultDeviceName());

      if (mode === "register") {
        // The keypair, the recovery code and both wraps, computed before the
        // request so the account never exists without its keys. Two Argon2id
        // runs at ~110 ms each -- felt as a slightly slower button, which is
        // the honest place for the cost.
        const keys = await prepareRegistrationKeys(password);
        const result = await register({
          username,
          displayName,
          password,
          device,
          email: email.trim(),
          accountKeys: keys.wire,
        });
        await persistKeypair(keys.keypair);
        // Not signed in yet: the recovery code screen stands between the
        // account existing and the app opening, because it is shown once.
        setPostAuth({
          kind: "show-code",
          code: keys.recoveryCode,
          session: saveSession(result),
        });
        return;
      }

      const result = await login({ username, password, device });
      const session = saveSession(result);

      // While the password is still in hand. Never kept beyond this.
      const unlock = await unlockAccountKey(password);
      if (unlock.status === "recovery-needed") {
        setPostAuth({ kind: "recovery", password, session });
        return;
      }

      onSignedIn(session);
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

  if (postAuth?.kind === "show-code") {
    return (
      <RecoveryCodeScreen
        code={postAuth.code}
        onDone={() => onSignedIn(postAuth.session)}
      />
    );
  }

  if (postAuth?.kind === "recovery") {
    return (
      <RecoveryPrompt
        password={postAuth.password}
        onRecovered={(newCode) =>
          setPostAuth({
            kind: "show-code",
            code: newCode,
            session: postAuth.session,
          })
        }
        onSkip={() => onSignedIn(postAuth.session)}
      />
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {mode === "login"
              ? "Sign in"
              : mode === "register"
                ? "Create an account"
                : "Reset your password"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Messages are end-to-end encrypted.
          </p>
        </div>

        {mode === "forgot" && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Email
            </span>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              Only a confirmed address can receive a reset link.
            </span>
          </label>
        )}

        {mode !== "forgot" && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {mode === "login" ? "Username or email" : "Username"}
          </span>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            {...(mode === "register"
              ? {
                  // Only when creating one. On sign-in this field also accepts
                  // a verified email address, and the username pattern would
                  // reject every one of them.
                  pattern: "[a-zA-Z0-9._\\-]{3,32}",
                  title:
                    "3–32 characters: letters, numbers, dot, underscore or hyphen",
                }
              : {})}
          />
        </label>
        )}

        {mode === "register" && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Display name
            </span>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
        )}

        {mode === "register" && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Email
            </span>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              You will need to confirm this before you can send or receive
              anything. It is also what lets you reset a forgotten password.
            </span>
          </label>
        )}

        {mode !== "forgot" && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Password
          </span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={12}
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            At least 12 characters.
          </span>
        </label>
        )}

        {sent && (
          <p className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
            If that address has a confirmed account, a reset link is on its way.
            It works once and expires in 30 minutes.
          </p>
        )}

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy
            ? "Working…"
            : mode === "login"
              ? "Sign in"
              : mode === "register"
                ? "Create account"
                : "Send reset link"}
        </Button>

        {mode === "login" && (
          <button
            type="button"
            onClick={() => {
              setMode("forgot");
              setError(null);
              setSent(false);
            }}
            className="w-full text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            Forgotten your password?
          </button>
        )}

        {mode === "forgot" && (
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError(null);
              setSent(false);
            }}
            className="w-full text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            Back to sign in
          </button>
        )}

        {mode !== "forgot" && (
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
        )}
      </form>
    </div>
  );
}

/**
 * The one and only display of a recovery code.
 *
 * It is never stored, never mailed, never shown again -- so this screen
 * blocks entry to the app until the person says they have it. No clipboard
 * button, deliberately: a code in the clipboard outlives this screen in a
 * place other apps can read, and the medium this is designed for is paper.
 */
function RecoveryCodeScreen({
  code,
  onDone,
}: {
  code: string;
  onDone: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Your recovery code
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            If you ever reset your password, this code is what brings your
            message history back. Write it down somewhere safe — not in an
            email, not in a screenshot.
          </p>
        </div>

        <p className="select-all rounded-md bg-neutral-100 px-3 py-3 text-center font-mono text-sm tracking-wide text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
          {code}
        </p>

        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This is the only time it will be shown. Nobody — including the
          server — can recover it for you.
        </p>

        <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have written this code down.</span>
        </label>

        <Button
          type="button"
          disabled={!acknowledged}
          onClick={onDone}
          className="w-full"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

/**
 * Shown when the password wrap failed to open after a sign-in: the mark of a
 * password reset no signed-in device repaired. Three exits, in order of how
 * much they preserve: the recovery code (everything), skipping (decide
 * later), starting fresh (old history becomes permanently unreadable).
 */
function RecoveryPrompt({
  password,
  onRecovered,
  onSkip,
}: {
  password: string;
  onRecovered: (newRecoveryCode: string) => void;
  onSkip: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingFresh, setConfirmingFresh] = useState(false);

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { newRecoveryCode } = await recoverWithCode(password, code);
      onRecovered(newRecoveryCode);
    } catch (caught) {
      setError(
        caught instanceof KeysError && caught.code === "WRONG_SECRET"
          ? "That code does not match. Check it against what you wrote down."
          : caught instanceof ApiError
            ? caught.message
            : "Cannot reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitFresh() {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCode } = await startFresh(password);
      onRecovered(recoveryCode);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Cannot reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-950">
      <form
        onSubmit={submitCode}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Unlock your history
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Your password changed since this account&apos;s history key was
            locked — usually because of a password reset. Enter your recovery
            code to unlock it under the new password.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Recovery code
          </span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
            required
            className="font-mono"
          />
        </label>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Working…" : "Unlock history"}
        </Button>

        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="w-full text-sm text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
        >
          Not now — I&apos;ll find my code first
        </button>

        {confirmingFresh ? (
          <div className="space-y-2 rounded-md bg-red-50 p-3 dark:bg-red-950">
            <p className="text-xs text-red-700 dark:text-red-300">
              Starting fresh makes a new history key. Messages locked under
              the old one can never be read again, by anyone. This cannot be
              undone.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitFresh()}
              className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              I understand — start fresh
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingFresh(true)}
            className="w-full text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            Lost your recovery code?
          </button>
        )}
      </form>
    </div>
  );
}
