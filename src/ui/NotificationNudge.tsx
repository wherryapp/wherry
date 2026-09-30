// The one-time "turn on notifications?" sheet on a phone shell.
//
// Why it exists (docs/prompts/native-push-plan.md §7.1): before the store
// listings, an app that stays silent unless somebody finds a toggle in
// Settings reads as broken -- the maintainer's 2026-09-01 instruction was
// that the phones get push before either listing, and push nobody turns on
// is not push. Decision D4 was "keep it" (2026-09-29). It stays one
// self-contained component that `withChrome` renders in one line.
//
// Shown once per Wherry device (the answer is keyed by the device id, which
// outlives a sign-out), after the first successful sync
// (so never over the login screen or an empty list), and only when the
// state is `ready` -- never when push is already on, blocked, or impossible
// here. Either answer, and dismissing the sheet, is remembered: asked once
// means asked once. The OS permission prompt comes only from "Turn on",
// never from the sheet appearing.

import { useEffect, useState } from "react";
import { withNativePush, nativePushAvailableHere } from "../sync/push";
import { Button, Popover } from "./kit";
import { useSyncStatus } from "./hooks";

const NUDGE_KEY = "wherry.nativePushNudge";

function answeredFor(deviceId: string): boolean {
  try {
    return window.localStorage.getItem(NUDGE_KEY) === deviceId;
  } catch {
    // No storage, no memory: better never to ask than to ask every launch.
    return true;
  }
}

function rememberAnswer(deviceId: string): void {
  try {
    window.localStorage.setItem(NUDGE_KEY, deviceId);
  } catch {
    // As above.
  }
}

export function NotificationNudge({ deviceId }: { deviceId: string }) {
  const { lastSyncAt } = useSyncStatus();
  const synced = lastSyncAt !== null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!synced || !nativePushAvailableHere() || answeredFor(deviceId)) return;
    let cancelled = false;
    withNativePush(async (native) => {
      const state = await native.nativeAvailability();
      if (!cancelled && state === "ready") setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [synced, deviceId]);

  if (!open) return null;

  const close = (): void => {
    rememberAnswer(deviceId);
    setOpen(false);
  };

  return (
    <Popover anchor={null} onClose={close} label="Notifications">
      <div className="space-y-3 px-5 pb-5 pt-3">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
          Turn on notifications?
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Get told about new messages and calls while the app is closed. A
          notification can say who it is from and which chat, never what was
          said. You can turn names off in Settings.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
            Not now
          </Button>
          <Button
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              rememberAnswer(deviceId);
              withNativePush(async (native) => {
                try {
                  await native.enableNative();
                } finally {
                  setBusy(false);
                  setOpen(false);
                }
              });
            }}
          >
            Turn on
          </Button>
        </div>
      </div>
    </Popover>
  );
}
