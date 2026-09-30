// The one sign-out question.
//
// Signing out of this device is asked about in the same words wherever it
// can be pressed: the account menu, and the bottom of Settings (decided
// 2026-09-29, sweep 1001 client-ui-6). One hook rather than two copies, so
// the two can never drift into one asking and the other not. It is app copy,
// so it lives here and not in kit.tsx, which carries no app wording.
//
// Not used by VerifyGate's Sign out: that is the gate's only exit, with
// nothing to lose, so it does not ask. Settings' Devices list: "Sign out" on
// this device asks in the same words (it is the same action, by way of the
// revoke route, so Settings asks through its own `useConfirm` with
// SIGN_OUT_CONFIRM); "Revoke" on another device deliberately does not ask
// (decided 2026-09-30): revoking is the fast security action for a lost
// phone, and the device can sign in again.

import { useCallback, type ReactNode } from "react";
import { useConfirm } from "./kit";

export const SIGN_OUT_CONFIRM = {
  message: "Sign out of this device?",
  confirmLabel: "Sign out",
} as const;

export function useConfirmedSignOut(onSignOut: () => void): {
  requestSignOut: () => void;
  signOutDialog: ReactNode;
} {
  const { confirm, confirmDialog } = useConfirm();
  const requestSignOut = useCallback(() => {
    void confirm(SIGN_OUT_CONFIRM).then((ok) => {
      if (ok) onSignOut();
    });
  }, [confirm, onSignOut]);
  return { requestSignOut, signOutDialog: confirmDialog };
}
