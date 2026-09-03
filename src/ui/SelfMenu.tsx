// The account menu behind the header avatar.
//
// The frequent layer, as against Settings the rare one: who you are, what
// you appear as, and the way to the page where the actual editing happens.
// Nothing moved out of Settings to be here -- the menu is a place to *set a
// status* and a door, and the door is the whole of its relationship with
// the settings page. Answering the design question that was asked
// (2026-09-03): yes, viewing yourself with a couple of quick options is a
// different thing from editing your account, and it is this.
//
// Status is the substance. Four rows, radio-shaped, the checked one
// marked; choosing away or busy shows a duration under them, because a
// do-not-disturb nobody clears is how messages get missed. The dot in the
// header is this menu's state made visible when it is closed.
//
// Sign out lives here as well as at the bottom of Settings. It confirms,
// which is what makes a row this close to the status list safe to have.

import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import type { StoredSession } from "../api/session";
import type { UserStatus } from "../api/types";
import { selfStatus, shownSelfStatus } from "../sync/self-status";
import { useSelfStatus } from "./hooks";
import {
  Avatar,
  CheckIcon,
  ErrorText,
  GearIcon,
  Input,
  Popover,
  PopoverRow,
  Select,
  SignOutIcon,
  useConfirm,
} from "./kit";
import {
  DURATION_OPTIONS,
  STATUS_OPTIONS,
  durationSeconds,
  expiryLabel,
  type DurationChoice,
} from "./status";
import { StatusDot } from "./StatusDot";

/** The status message's ceiling -- the schema's and migration 0025's. */
const STATUS_TEXT_MAX = 80;

export function SelfMenu({
  anchor,
  session,
  unreadAnnouncements,
  onClose,
  onOpenSettings,
  onSignOut,
}: {
  anchor: HTMLElement | null;
  session: StoredSession;
  /** Carried onto the Settings row, where the header's dot used to lead. */
  unreadAnnouncements: number;
  onClose: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const status = useSelfStatus();
  const [duration, setDuration] = useState<DurationChoice>("until-changed");
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  // The message field is a draft until saved (Enter or blur), so typing
  // does not post a request per keystroke. Re-seeded when the server's
  // value changes underneath -- another device set it, or it lapsed --
  // by the "adjust state during render" pattern rather than an effect, so
  // there is no frame showing the stale draft first.
  const [draft, setDraft] = useState(status.text ?? "");
  const [seededFrom, setSeededFrom] = useState(status.text ?? null);
  if ((status.text ?? null) !== seededFrom) {
    setSeededFrom(status.text ?? null);
    setDraft(status.text ?? "");
  }

  async function saveText(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const next = draft.trim() || null;
    if (next === (status.text ?? null)) return;
    setError(null);
    try {
      await selfStatus.setText(next);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save that.");
    }
  }

  async function choose(next: UserStatus, choice: DurationChoice = duration): Promise<void> {
    setError(null);
    try {
      await selfStatus.set(next, durationSeconds(choice, new Date()));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not change your status.");
    }
  }

  const timed = status.status === "away" || status.status === "dnd";

  return (
    <Popover anchor={anchor} onClose={onClose} label="Account">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="relative shrink-0">
          <Avatar
            size="md"
            name={session.user.displayName}
            userId={session.user.id}
            hue={session.user.avatarHue}
          />
          {status.loaded && <StatusDot status={shownSelfStatus(status)} size="md" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {session.user.displayName}
          </span>
          <span className="block truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
            @{session.user.username}
          </span>
        </span>
      </div>

      {/* The status message: what friends see beside your dot. Plain text
          the server can read -- said here, once, where it is typed. */}
      <form onSubmit={(event) => void saveText(event)} className="px-4 pb-3">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void saveText()}
          // Enter saves explicitly as well as through the form's implicit
          // submission, and drops focus so the phone keyboard goes away.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          maxLength={STATUS_TEXT_MAX}
          placeholder="What are you up to?"
          aria-label="Status message"
          className="text-sm"
        />
        <span className="mt-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
          Friends see this. Not encrypted.
          {status.expiresAt && status.text ? " Clears with your status." : ""}
        </span>
      </form>

      <div
        role="radiogroup"
        aria-label="Status"
        className="border-t border-neutral-200 py-1 dark:border-neutral-800"
      >
        {STATUS_OPTIONS.map((option) => {
          const checked = status.loaded && status.status === option.status;
          return (
            <button
              key={option.status}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => void choose(option.status)}
              className="flex w-full items-start gap-3 px-4 py-2 text-left transition-colors hover:bg-neutral-100 pointer-coarse:min-h-11 dark:hover:bg-neutral-800"
            >
              <StatusDot status={option.status} size="md" corner={false} className="mt-1" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-neutral-800 dark:text-neutral-100">
                  {option.label}
                </span>
                <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
                  {option.description}
                </span>
              </span>
              {checked && (
                <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent-600 dark:text-accent-400" />
              )}
            </button>
          );
        })}

        {timed && (
          <div className="px-4 pt-1 pb-2">
            <Select
              aria-label="Clear status"
              value={duration}
              onChange={(event) => {
                const next = event.target.value as DurationChoice;
                setDuration(next);
                void choose(status.status, next);
              }}
              className="w-full"
            >
              {DURATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            {status.expiresAt && (
              <span className="mt-1 block text-[11px] text-neutral-500 dark:text-neutral-400">
                {expiryLabel(status.expiresAt, new Date())}
              </span>
            )}
          </div>
        )}
        {error && <ErrorText className="px-4 pb-1">{error}</ErrorText>}
      </div>

      <div className="border-t border-neutral-200 py-1 dark:border-neutral-800">
        <PopoverRow
          onClick={onOpenSettings}
          icon={<GearIcon />}
          trailing={
            unreadAnnouncements > 0 ? (
              <span
                aria-label={`${unreadAnnouncements} unread ${
                  unreadAnnouncements === 1 ? "announcement" : "announcements"
                }`}
                className="rounded-full bg-accent-600 px-1.5 text-[10px] font-semibold text-white"
              >
                {unreadAnnouncements}
              </span>
            ) : undefined
          }
        >
          Settings
        </PopoverRow>
        <PopoverRow
          onClick={() => {
            void confirm({ message: "Sign out of this device?", confirmLabel: "Sign out" }).then(
              (ok) => {
                if (ok) onSignOut();
              },
            );
          }}
          icon={<SignOutIcon />}
        >
          Sign out
        </PopoverRow>
      </div>
      {confirmDialog}
    </Popover>
  );
}

/** Re-exported for Chat.tsx's header, so the dot there and the menu's
 *  header agree on which status is shown. */
export function SelfStatusDot({ children }: { children?: ReactNode }) {
  const status = useSelfStatus();
  if (!status.loaded) return <>{children}</>;
  return (
    <>
      {children}
      <StatusDot status={shownSelfStatus(status)} size="sm" />
    </>
  );
}
