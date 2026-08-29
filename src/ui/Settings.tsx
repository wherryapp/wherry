// Account settings.
//
// A full-screen panel rather than a route, because the app has no router and
// adding one for a single screen would be more machinery than the screen. It
// also happens to be the right shape on a phone, where a settings *page* is
// what people expect anyway.

import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  changeDisplayName,
  changePassword,
  fetchAccountSettings,
  fetchAttachmentUsage,
  fetchDevices,
  revokeDevice,
  setReadReceipts,
  type AccountDevice,
  type AttachmentUsage,
} from "../api/client";
import type { StoredSession } from "../api/session";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-neutral-200 px-4 py-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h2>
      {description && (
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";

const buttonClass =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function Settings({
  session,
  onClose,
  onSignedOut,
}: {
  session: StoredSession;
  onClose: () => void;
  /** Revoking the device you are on is a sign-out, and the app has to follow. */
  onSignedOut: () => void;
}) {
  const [displayName, setDisplayName] = useState(session.user.displayName);
  const [receipts, setReceipts] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [settings, deviceList, attachmentUsage] = await Promise.all([
          fetchAccountSettings(),
          fetchDevices(),
          fetchAttachmentUsage(),
        ]);
        setDisplayName(settings.displayName);
        setReceipts(settings.readReceiptsEnabled);
        setDevices(deviceList.devices);
        setUsage(attachmentUsage);
      } catch {
        setError("Could not load your settings.");
      }
    })();
  }, []);

  function report(caught: unknown, fallback: string): void {
    setNote(null);
    setError(caught instanceof ApiError ? caught.message : fallback);
  }

  async function submitName(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await changeDisplayName(displayName.trim());
      setDisplayName(result.displayName);
      // Said out loud because it is surprising otherwise: the name is carried
      // by conversation metadata, not by messages, so what other people see
      // updates when their client next refreshes rather than immediately.
      setNote("Saved. Other people will see it the next time their app syncs.");
    } catch (caught) {
      report(caught, "Could not save that name.");
    }
  }

  async function toggleReceipts(next: boolean) {
    setError(null);
    setReceipts(next);
    try {
      await setReadReceipts(next);
      setNote(null);
    } catch (caught) {
      setReceipts(!next);
      report(caught, "Could not change that setting.");
    }
  }

  async function revoke(device: AccountDevice) {
    setError(null);
    try {
      await revokeDevice(device.id);
      if (device.current) {
        // Revoking this device killed this session. Anything else the app does
        // from here would be a request that 401s.
        onSignedOut();
        return;
      }
      setDevices((await fetchDevices()).devices);
      setNote("That device has been signed out and will stop receiving messages.");
    } catch (caught) {
      report(caught, "Could not revoke that device.");
    }
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button
          onClick={onClose}
          aria-label="Back"
          className="-ml-2 rounded px-2 py-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ←
        </button>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Settings
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(note || error) && (
          <p
            className={`px-4 py-2 text-xs ${
              error
                ? "text-red-600 dark:text-red-400"
                : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {error ?? note}
          </p>
        )}

        <Section title="Display name" description={`Signed in as ${session.user.username}`}>
          <form onSubmit={submitName} className="flex gap-2">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={displayName.trim().length === 0}
              className={buttonClass}
            >
              Save
            </button>
          </form>
        </Section>

        <PasswordSection onDone={setNote} onError={setError} />

        <Section
          title="Read receipts"
          description="When off, other people cannot see how far you have read. You can still see theirs."
        >
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={receipts ?? false}
              disabled={receipts === null}
              onChange={(e) => void toggleReceipts(e.target.checked)}
              className="h-4 w-4"
            />
            Let others see when I have read their messages
          </label>
        </Section>

        <Section
          title="Devices"
          description="Revoking a device signs it out and stops it receiving new messages."
        >
          {devices === null ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-neutral-900 dark:text-neutral-100">
                      {device.displayName}
                      {device.current && (
                        <span className="ml-1 text-xs text-neutral-500">
                          · this device
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                      {device.revokedAt
                        ? "Revoked"
                        : device.lastSeenAt
                          ? `Last used ${new Date(device.lastSeenAt).toLocaleDateString()}`
                          : "Never used"}
                    </span>
                  </span>
                  {!device.revokedAt && (
                    <button
                      onClick={() => void revoke(device)}
                      className="shrink-0 text-xs text-red-600 hover:underline dark:text-red-400"
                    >
                      {device.current ? "Sign out" : "Revoke"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {usage && (
          <Section
            title="Storage"
            description={`Attachments are deleted after ${usage.retentionDays} days.`}
          >
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              {bytes(usage.usedBytes)} of {bytes(usage.quotaBytes)} used ·{" "}
              {bytes(usage.maxBytes)} per file
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}

function PasswordSection({
  onDone,
  onError,
}: {
  onDone: (note: string) => void;
  onError: (error: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { otherSessionsRevoked } = await changePassword(current, next);
      setCurrent("");
      setNext("");
      // The count is the reassurance somebody changing a password after a
      // scare is actually looking for.
      onDone(
        otherSessionsRevoked > 0
          ? `Password changed. ${otherSessionsRevoked} other session${
              otherSessionsRevoked === 1 ? " was" : "s were"
            } signed out.`
          : "Password changed.",
      );
    } catch (caught) {
      onError(
        caught instanceof ApiError
          ? caught.message
          : "Could not change your password.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Password"
      description="Changing it signs out every other device."
    >
      <form onSubmit={submit} className="space-y-2">
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          className={inputClass}
        />
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="New password (at least 12 characters)"
          autoComplete="new-password"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || current.length === 0 || next.length < 12}
          className={buttonClass}
        >
          {busy ? "…" : "Change password"}
        </button>
      </form>
    </Section>
  );
}
