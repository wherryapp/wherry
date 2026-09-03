// The presence dot, wherever one is drawn: a DM row, the header avatar, a
// profile card, the picker. One component so the colours cannot drift
// between surfaces -- the classes come from ui/status.ts, which is the
// vocabulary the server's presence-rules.ts is mirrored by.
//
// Not in kit.tsx because kit stays free of API types on purpose, and
// UserStatus is one.

import type { UserStatus } from "../api/types";
import { statusDotClass, statusLabel } from "./status";

export function StatusDot({
  status,
  size = "sm",
  corner = true,
  className = "",
}: {
  status: UserStatus;
  /** `sm` sits on a small avatar; `md` on a medium one or inline in text. */
  size?: "sm" | "md";
  /** Absolutely positioned over an avatar's bottom-right corner (the
   *  wrapper must be `relative`); false renders it inline. */
  corner?: boolean;
  className?: string;
}) {
  const box = size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3";
  // The ring separates a filled dot from the avatar underneath it. Appear
  // offline is hollow and brings its own border from status.ts, so it gets
  // NO ring here -- a second border colour at the same specificity would
  // be decided by stylesheet order, not intent (see statusDotClass).
  const ring =
    status === "invisible" ? "" : "border-2 border-white dark:border-neutral-900";
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      className={`block shrink-0 rounded-full ${box} ${ring} ${statusDotClass(status)} ${
        corner ? "absolute bottom-0 right-0" : ""
      } ${className}`}
    />
  );
}
