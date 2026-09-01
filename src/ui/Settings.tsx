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
  fetchAccountSettings,
  fetchAttachmentUsage,
  fetchDevices,
  resendVerification,
  revokeDevice,
  setEmail,
  setReadReceipts,
  type AccountDevice,
  type AttachmentUsage,
} from "../api/client";
import type { StoredSession } from "../api/session";
import { changePasswordWithRewrap } from "../crypto/account";
import { APP_VERSION } from "../sync/engine";
import {
  availability as pushAvailability,
  disable as disablePush,
  enable as enablePush,
  isSubscribed,
  type PushState,
} from "../sync/push";
import { useAnnouncements } from "./hooks";
import {
  Button,
  ErrorText,
  Input,
  LoadingLine,
  Note,
  Panel,
  PanelSection,
} from "./kit";

/**
 * Stamped at build time the same way BUILD_COMMIT is (see sync/engine.ts) --
 * a bare VITE_-prefixed env var Vite embeds automatically, set via
 * client/Dockerfile and docker-compose.prod.yml. Unset by default, which is
 * what keeps dev and a self-hosted instance clean: no monetization ask
 * unless the operator deliberately configures one.
 */
const TIP_URL: string | undefined = import.meta.env["VITE_TIP_URL"];

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
  const [emailAddress, setEmailAddress] = useState("");
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts hidden rather than shown: this is a server-side flag specifically
  // so it can be turned off for people who should not see it, and defaulting
  // to visible until the fetch resolves would flash it at exactly them.
  const [tipJarEnabled, setTipJarEnabled] = useState(false);

  // The minimal announcements surface: a section that exists only while
  // there are announcements to show (the feature flag off means the engine
  // stored none, so this is dark exactly when the feature is). Its real
  // face is a UI-reform design question -- this is the framework's proof it
  // works, not the presentation.
  const { announcements, markSeen } = useAnnouncements();

  // Opening Settings with the section visible is what "seen" means. Keyed on
  // the newest id so a new announcement published while the panel is open is
  // marked too.
  const newestAnnouncement = announcements[0]?.id;
  useEffect(() => {
    if (newestAnnouncement) markSeen();
  }, [newestAnnouncement, markSeen]);

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
        setEmailAddress(settings.email ?? "");
        setSavedEmail(settings.email);
        setEmailVerified(settings.emailVerified);
        setDevices(deviceList.devices);
        setUsage(attachmentUsage);
        setTipJarEnabled(settings.features.tipJar);
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


  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await setEmail(emailAddress.trim());
      setSavedEmail(emailAddress.trim());
      setEmailVerified(false);
      // Deliberately vague, because the server is deliberately vague: an
      // address somebody else already uses returns the same 204 as a fresh
      // one, so that this screen cannot be used to test whether an address is
      // registered. Promising "we sent you a link" would be a lie in that
      // case; "check your email" is true either way.
      setNote("Check that inbox for a confirmation link.");
    } catch (caught) {
      report(caught, "Could not save that address.");
    }
  }

  async function resend() {
    setError(null);
    try {
      await resendVerification();
      setNote("Sent again. The previous link no longer works.");
    } catch (caught) {
      report(caught, "Could not send that email.");
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
    <Panel title="Settings" onClose={onClose}>
      <div>
        {(note || error) &&
          (error ? (
            <ErrorText className="px-4 py-2">{error}</ErrorText>
          ) : (
            <Note className="px-4 py-2">{note}</Note>
          ))}

        <PanelSection
          title="Display name"
          description={
            <>
              Signed in as{" "}
              <span className="font-mono">@{session.user.username}</span>
            </>
          }
        >
          <form onSubmit={submitName} className="flex gap-2">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
            />
            <Button
              type="submit"
              size="sm"
              disabled={displayName.trim().length === 0}
            >
              Save
            </Button>
          </form>
        </PanelSection>

        <PanelSection
          title="Email"
          description="Used to sign in and to reset your password. Nothing else."
        >
          <form onSubmit={submitEmail} className="flex gap-2">
            <Input
              type="email"
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
              placeholder="you@example.com"
            />
            <Button
              type="submit"
              size="sm"
              disabled={
                emailAddress.trim().length === 0 ||
                emailAddress.trim() === savedEmail
              }
            >
              Save
            </Button>
          </form>

          {savedEmail && emailVerified === false && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Not confirmed yet — until it is, this address cannot sign you in
              or reset your password.{" "}
              <button
                onClick={() => void resend()}
                className="underline underline-offset-2"
              >
                Send the link again
              </button>
            </p>
          )}

          {savedEmail && emailVerified && (
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Confirmed.
            </p>
          )}
        </PanelSection>

        <PasswordSection onDone={setNote} onError={setError} />

        <PanelSection
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
        </PanelSection>

        <PanelSection
          title="Notifications"
          description={`This device: ${session.device.displayName}.`}
        >
          <NotificationSetting />
        </PanelSection>

        <PanelSection
          title="Devices"
          description="Revoking a device signs it out and stops it receiving new messages."
        >
          {devices === null ? (
            <LoadingLine className="text-xs" />
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
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      onClick={() => void revoke(device)}
                      className="shrink-0 hover:underline"
                    >
                      {device.current ? "Sign out" : "Revoke"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </PanelSection>

        {usage && (
          <PanelSection
            title="Storage"
            description={`Attachments are deleted after ${usage.retentionDays} days.`}
          >
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              {bytes(usage.usedBytes)} of {bytes(usage.quotaBytes)} used ·{" "}
              {bytes(usage.maxBytes)} per file
            </p>
          </PanelSection>
        )}

        {announcements.length > 0 && (
          <PanelSection title="What's new">
            <ul className="space-y-5">
              {announcements.map((entry) => (
                <li key={entry.id}>
                  <p className="flex items-center gap-2">
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        entry.kind === "release"
                          ? "bg-accent-50 text-accent-700 dark:bg-accent-950 dark:text-accent-100"
                          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                      }`}
                    >
                      {entry.kind === "release" ? "Release" : "News"}
                    </span>
                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {entry.title}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {new Date(entry.publishedAt).toLocaleDateString()}
                    {entry.version && ` · ${entry.version}`}
                  </p>
                  {/* The body is markdown by contract, shown as plain text
                      for now -- whether it deserves real rendering (and the
                      dependency that costs) is the reform's call. */}
                  <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-sm text-neutral-700 dark:text-neutral-200">
                    {entry.body}
                  </p>
                </li>
              ))}
            </ul>
          </PanelSection>
        )}

        {TIP_URL && tipJarEnabled && (
          <PanelSection title="Support the project">
            <a
              href={TIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-neutral-700 underline underline-offset-2 dark:text-neutral-200"
            >
              Open tip jar ↗
            </a>
          </PanelSection>
        )}

        {/* Last, where every app keeps it. It used to be a header link on the
            main screen -- prime space for the rarest action in the app. */}
        <div className="px-4 py-5">
          <Button variant="secondary" onClick={() => onSignedOut()} className="w-full">
            Sign out
          </Button>
        </div>

        {/* Below sign-out, not beside it -- this is trivia, not a control.
            Absent entirely before tagging starts (APP_VERSION is "unknown"
            in dev and in any build the deploy pipeline did not produce),
            same convention as the tip jar section above hiding itself. */}
        {APP_VERSION !== "unknown" && (
          <p className="px-4 pb-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
            Version {APP_VERSION}
          </p>
        )}
      </div>
    </Panel>
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
      // The rewrap variant keeps the account key's password wrap in step
      // with the new password -- see crypto/account.ts. Without it, the next
      // sign-in would land on the recovery-code screen for no reason.
      const { otherSessionsRevoked } = await changePasswordWithRewrap(
        current,
        next,
      );
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
    <PanelSection
      title="Password"
      description="Changing it signs out every other device."
    >
      <form onSubmit={submit} className="space-y-2">
        <Input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
        />
        <Input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="New password (at least 12 characters)"
          autoComplete="new-password"
        />
        <Button
          type="submit"
          size="sm"
          loading={busy}
          disabled={current.length === 0 || next.length < 12}
        >
          Change password
        </Button>
      </form>
    </PanelSection>
  );
}

/**
 * The notification toggle, and an explanation when it cannot be one.
 *
 * Never asks on load. A permission prompt that arrives before somebody knows
 * what the app is gets refused, and a refusal on iOS is permanent from the
 * page's side -- only the browser's own settings can undo it. So this is a
 * button, and the prompt happens when it is pressed.
 *
 * It lived in the conversation list's footer until the stage-2 shell work
 * (docs/ui-reform-plan.md); a per-device capability is a setting, and the
 * list's footer was debug chrome on the app's most valuable screen.
 */
function NotificationSetting() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const available = pushAvailability();
      if (available.state !== "ready") {
        if (!cancelled) setState(available.state);
        return;
      }
      const on = await isSubscribed();
      if (!cancelled) setState(on ? "on" : "ready");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === null || state === "unsupported") {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        This browser cannot show notifications.
      </p>
    );
  }

  if (state === "needs-install") {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Add this to your home screen to get notifications.
      </p>
    );
  }

  if (state === "blocked") {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Notifications are blocked in your browser settings.
      </p>
    );
  }

  if (state === "server-disabled") {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Notifications are not set up on this server.
      </p>
    );
  }

  const on = state === "on";

  return (
    <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={() => {
          setBusy(true);
          void (on ? disablePush() : enablePush())
            .then(setState)
            .catch(() => setState(on ? "on" : "ready"))
            .finally(() => setBusy(false));
        }}
        className="h-4 w-4"
      />
      Notify me about new messages on this device
    </label>
  );
}
