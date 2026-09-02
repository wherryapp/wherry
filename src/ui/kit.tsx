// The shared visual primitives, and the only place their classlists live.
//
// Before this file existed the text-input classlist was pasted verbatim in
// seven files, the primary button had three slightly different paddings, and
// error text had three unrelated treatments -- each file re-deciding what a
// button looks like, and drifting. The reform (docs/ui-reform-plan.md)
// restyles the app by editing THIS file; components say what a thing is
// (primary button, muted note, panel header) and this file says how it
// looks.
//
// Stage 1 deliberately encodes the app's existing look -- neutral-900
// primary buttons, the same paddings -- so adopting the kit ships as a
// near-invisible change. Later stages change these classlists in place.
//
// The `className` prop on each primitive is for LAYOUT (widths, margins,
// flex behaviour), not for restyling -- passing a color through it is
// re-creating the drift this file removes. No class-merging library:
// layout classes and style classes do not collide, and a dependency needs
// a reason (CLAUDE.md).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// Hand-rolled inline SVGs rather than an icon package: the app needs a
// handful, they inherit currentColor, and a dependency needs a reason.
// 20x20 viewBox, stroke-based, drawn to read at 16-20px.

type IconProps = { className?: string };

export function ChevronLeftIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M12.5 4.5 7 10l5.5 5.5" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function UsersIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <circle cx="7.5" cy="6.5" r="3" />
      <path d="M2 17c0-3 2.5-4.5 5.5-4.5S13 14 13 17" />
      <path d="M13.5 4a3 3 0 0 1 0 5M15.5 12.6c1.7.7 2.5 2.2 2.5 4.4" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M2.5 10 17 3.2c.5-.24 1 .27.78.78L11.5 17.5c-.23.53-1 .48-1.16-.07l-1.6-5.36a.6.6 0 0 0-.4-.4L2.57 10.9c-.55-.16-.6-.93-.07-1.16Z" />
    </svg>
  );
}

/** An unmuted conversation's toggle state, and the list row's default. */
export function BellIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M5 8a5 5 0 0 1 10 0c0 3.2 1 4.6 1.5 5.2H3.5C4 12.6 5 11.2 5 8Z" />
      <path d="M8.2 16a1.8 1.8 0 0 0 3.6 0" />
    </svg>
  );
}

/**
 * Muted: the same closed bell as BellIcon, slashed -- push is silenced for
 * this conversation. Was drawn as two disjoint arcs with a real gap between
 * them, which is why only the muted state looked broken; this is BellIcon's
 * own two paths with the slash stroke added on top, so both states read at
 * the same weight.
 */
export function BellOffIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M5 8a5 5 0 0 1 10 0c0 3.2 1 4.6 1.5 5.2H3.5C4 12.6 5 11.2 5 8Z" />
      <path d="M8.2 16a1.8 1.8 0 0 0 3.6 0" />
      <path d="M3.5 3.5l13 13" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M3.5 5.5h13M8 5V3.5h4V5M5 5.5l.7 10a1.5 1.5 0 0 0 1.5 1.4h5.6a1.5 1.5 0 0 0 1.5-1.4l.7-10" />
      <path d="M8.2 8.5v5M11.8 8.5v5" />
    </svg>
  );
}

/** Edit, in a bubble's action bar on your own messages. */
export function PencilIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="m12.2 4.3 3.5 3.5L7 16.5l-4 .9.9-4Z" />
      <path d="m11 5.5 3.5 3.5" />
    </svg>
  );
}

/**
 * A pencil over a square: the "new message" glyph every phone's messaging
 * app puts in its list header, and what the sidebar's compose control is.
 * Same pencil as PencilIcon, smaller, over an open box.
 */
export function ComposeIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M9 4.5H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16.5h9a1.5 1.5 0 0 0 1.5-1.5v-4" />
      <path d="m14.3 3.2 2.5 2.5-6.3 6.3-3.2.7.7-3.2Z" />
    </svg>
  );
}

/** Reply, in a bubble's action bar and the composer's context bar. */
export function ReplyIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M8 4 3.5 8.5 8 13" />
      <path d="M3.5 8.5h8a5 5 0 0 1 5 5V16" />
    </svg>
  );
}

/** The "more actions" affordance at a bubble's edge. */
export function DotsIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <circle cx="4.5" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="15.5" cy="10" r="1.5" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

export function PhoneIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M4.5 3.5h2.8l1.4 3.4-1.9 1.4a9.5 9.5 0 0 0 4.9 4.9l1.4-1.9 3.4 1.4v2.8a1.5 1.5 0 0 1-1.6 1.5A12.8 12.8 0 0 1 3 5.1a1.5 1.5 0 0 1 1.5-1.6Z" />
    </svg>
  );
}

export function PhoneOffIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M4.5 3.5h2.8l1.4 3.4-1.9 1.4a9.5 9.5 0 0 0 4.9 4.9l1.4-1.9 3.4 1.4v2.8a1.5 1.5 0 0 1-1.6 1.5A12.8 12.8 0 0 1 3 5.1a1.5 1.5 0 0 1 1.5-1.6Z" />
      <path d="m3 17 14-14" />
    </svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <rect x="7" y="2.5" width="6" height="9" rx="3" />
      <path d="M4 9.5a6 6 0 0 0 12 0M10 15.5v2M7.5 17.5h5" />
    </svg>
  );
}

export function MicOffIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M13 8V5.5a3 3 0 0 0-6 0v1M7 8.5v0a3 3 0 0 0 5.2 2.1M4 9.5a6 6 0 0 0 9.7 4.7M16 9.5a6 6 0 0 1-.8 3M10 15.5v2M7.5 17.5h5" />
      <path d="m3 17 14-14" />
    </svg>
  );
}

export function SpeakerIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M3 7.5h3l4-3v11l-4-3H3z" />
      <path d="M13 7a4 4 0 0 1 0 6M15.5 4.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

export function HeadphonesIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M3 12v-1.5a7 7 0 0 1 14 0V12" />
      <rect x="3" y="11" width="3.5" height="5.5" rx="1.2" />
      <rect x="13.5" y="11" width="3.5" height="5.5" rx="1.2" />
    </svg>
  );
}

export function PinIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      <path d="M8 3h4l.5 5 2.5 2v1.5H5V10l2.5-2L8 3Z" />
      <path d="M10 11.5V17" />
    </svg>
  );
}

export function GifIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("h-5 w-5", className)}
      aria-hidden="true"
    >
      {/* The letters, not a film strip or a play triangle: "GIF" is what the
          control is called out loud, and at 20px a wordmark reads where a
          pictogram of an animation does not. */}
      <rect x="2" y="4.5" width="16" height="11" rx="2" />
      <path d="M8 8.5a1.5 1.5 0 0 0-2.5 1.1v.8A1.5 1.5 0 0 0 8 11.5v-1H7" />
      <path d="M10.5 8.5v3" />
      <path d="M13 11.5v-3h2" />
      <path d="M13 10.2h1.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS = {
  /**
   * The one action a screen is for. The accent fill, settled 2026-08-31:
   * the send button had been the app's only accent-filled control while
   * this variant was neutral-900, and the app's single most-used action is
   * a better vote on what "primary" means than the kit's first draft was.
   * One set of classes for both themes -- the accent is tuned to carry
   * white text on light and dark alike (the send button always did).
   */
  primary:
    "bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50",
  /** Everything beside it. */
  secondary:
    "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800",
  /** Destructive, and styled to look it before it is pressed. */
  danger:
    "border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  /** Text that acts. The header links and row actions. */
  ghost:
    "text-neutral-500 hover:text-neutral-800 disabled:opacity-50 dark:hover:text-neutral-200",
  /**
   * Ghost's destructive counterpart -- text that acts, but wrecks something.
   * Reinvented by hand at five call sites (Block, Revoke, Remove, Unpin, Ban)
   * before this existed, each pasting the same red plus whatever hover the
   * site felt like (underline, a background tint) -- that hover treatment
   * stays a per-site className rather than living here, so this only carries
   * what all five actually agreed on: the color and the disabled state.
   */
  "ghost-danger": "text-red-600 disabled:opacity-50 dark:text-red-400",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  loading = false,
  disabled,
  children,
  ...rest
}: {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: "md" | "sm";
  className?: string;
  /**
   * Was a literal "…" label at every call site, each also remembering to
   * disable the button so a second click couldn't fire mid-request. No
   * spinner -- this is the same text swap those sites already did, just not
   * fourteen times over.
   */
  loading?: boolean;
} & React.ComponentProps<"button">) {
  // Both ghost variants are text, not boxes -- the scale-press and padding
  // below are for buttons that look like buttons, and would misalign ghost
  // text against the labels it sits beside.
  const ghost = variant === "ghost" || variant === "ghost-danger";
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        // The press scale is the touch feedback a native button has and a
        // web one lacks; motion-safe so reduced-motion gets color-only
        // feedback. Ghost buttons skip it -- text that shrinks reads as a
        // glitch, not a press.
        "rounded-md text-sm font-medium transition",
        !ghost && "motion-safe:active:scale-[0.97]",
        // Ghost buttons are text, not boxes; padding would misalign them
        // with the labels they sit beside.
        !ghost && (size === "md" ? "px-3 py-2" : "px-3 py-1.5"),
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? "…" : children}
    </button>
  );
}

/**
 * An icon-only button. `label` is mandatory because an icon button with no
 * accessible name is a mystery box to a screen reader -- making it a
 * required prop is cheaper than remembering.
 */
export function IconButton({
  label,
  className,
  children,
  ...rest
}: {
  label: string;
  className?: string;
  children: ReactNode;
} & Omit<React.ComponentProps<"button">, "aria-label" | "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cx(
        "rounded p-1.5 text-neutral-500 transition hover:text-neutral-900 motion-safe:active:scale-90 dark:hover:text-neutral-100",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The back control every full-screen panel and the phone thread share. */
export function BackButton({
  onClick,
  label = "Back",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <IconButton label={label} onClick={onClick} className="-ml-2">
      <ChevronLeftIcon />
    </IconButton>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

/**
 * The text input. `text-base md:text-sm` is load-bearing: below 16px iOS
 * zooms the page on focus, so the phone gets 16 and desktop the compact
 * size. Focus is the border (no ring) -- a field already is a box, and the
 * global :focus-visible outline is for things that otherwise show nothing.
 */
/**
 * Spread into any input where a *handle* gets typed -- a username, a hub
 * id, an invite code. iOS capitalizes the first letter of ordinary text
 * inputs and squiggles anything not in its dictionary, which for an
 * identifier means someone registers or searches "Ios-test-a" while
 * reading it as what they typed (found live in the iOS shell, 2026-09-01,
 * on both the register form and the friends add field). One constant so
 * the next handle input cannot forget one of the three.
 */
export const handleInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

export function Input({
  className,
  ...rest
}: { className?: string } & React.ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 outline-none transition-colors focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The `<select>`, styled to match Input's box but sized for the small inline
 * pickers it is used for -- HubDetails' role dropdown and its two invite-link
 * selects, hand-styled identically three times before this. Vertical padding
 * is not baked in: the role select uses `py-0.5` where the invite selects use
 * `py-1`, so callers push it themselves via className, the same carve-out
 * Button's ghost variants make for their own padding.
 */
export function Select({
  className,
  children,
  ...rest
}: { className?: string } & React.ComponentProps<"select">) {
  return (
    <select
      className={cx(
        "rounded border border-neutral-300 bg-white px-1 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/**
 * A labelled form field: the label span above whatever goes below it.
 * Repeated seven times across Login and VerifyGate, each a `<label>`
 * wrapping the same span and an `Input` -- this pulls out only the label,
 * not what follows it, because what follows (a footnote span, or nothing)
 * differs at nearly every call site, and forcing that into a prop would
 * just move the duplication into a `note` union instead of removing it.
 */
export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * The "Loading…" placeholder shown while a panel's list is still in flight.
 * Three sites wrote a `<p>` or `<div>` for this by hand, two of them
 * forgetting the dark-mode color entirely -- `text-neutral-500` alone reads
 * far too light against a dark background with nothing to lift it.
 * `className` is for whatever font-size and padding the site around it
 * already used; only the color pair lives here.
 */
export function LoadingLine({ className }: { className?: string }) {
  return (
    <p className={cx("text-neutral-500 dark:text-neutral-400", className)}>
      Loading…
    </p>
  );
}

/**
 * Inline problem text, next to the thing that failed. `boxed` swaps that
 * for the red banner treatment three auth screens each built by hand for a
 * form-level failure (as opposed to a per-field one) -- same slot, same
 * component, a container with more visual weight instead of a second one.
 */
export function ErrorText({
  children,
  className,
  boxed = false,
}: {
  children: ReactNode;
  className?: string;
  boxed?: boolean;
}) {
  return (
    <p
      className={cx(
        boxed
          ? "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          : "text-xs text-red-600 dark:text-red-400",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Inline confirmation or context, same slot as ErrorText. `boxed` is its
 * neutral counterpart to ErrorText's red one -- the same banner treatment
 * for a success or informational message instead of a failure.
 */
export function Note({
  children,
  className,
  boxed = false,
}: {
  children: ReactNode;
  className?: string;
  boxed?: boolean;
}) {
  return (
    <p
      className={cx(
        boxed
          ? "rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          : "text-xs text-neutral-600 dark:text-neutral-300",
        className,
      )}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Auth shell
// ---------------------------------------------------------------------------

const AUTH_GUTTER = { sm: "p-4", md: "p-6" } as const;

/**
 * The scroll shell and centered card behind Login's three screens,
 * VerifyGate, and both of EmailLanding's -- pasted verbatim five times and
 * already drifting once: the `overflow-y-auto` wrapper below was added to
 * Login.tsx's copies as a fix (#root is a fixed, viewport-height box with no
 * scroll of its own, so a form taller than it -- registration, with five
 * fields -- had an unreachable bottom) and never carried to the other two
 * files, so VerifyGate and EmailLanding kept the bug this recreates as a
 * component specifically so it can't happen again.
 *
 * `onSubmit` makes the card a `<form>` instead of a `<div>` -- three of the
 * five sites submit on Enter, two just display a result. `gutter` is the one
 * real difference among the five: EmailLanding's pages sit in a narrower
 * `p-4` margin where the other four use `p-6`. Everything else about the
 * card -- width, spacing, border, radius, shadow -- is identical at every
 * call site, which is the point of pulling it out.
 */
export function AuthShell({
  children,
  onSubmit,
  gutter = "md",
}: {
  children: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  gutter?: keyof typeof AUTH_GUTTER;
}) {
  const card =
    "w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900";
  return (
    <div className="h-full overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div
        className={cx(
          "flex min-h-full items-center justify-center",
          AUTH_GUTTER[gutter],
        )}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className={card}>
            {children}
          </form>
        ) : (
          <div className={card}>{children}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The full-screen panel
// ---------------------------------------------------------------------------

/**
 * The shape Friends, Settings and GroupDetails share: a header with a back
 * control and a title, over a scrolling body. They had each built it
 * separately, identically, by convention.
 *
 * Escape closes it -- these panels replace the whole screen, and a keyboard
 * user's way back should not be tabbing to the one button. Listener on the
 * document because the panel does not hold focus.
 */
export function Panel({
  title,
  onClose,
  children,
  headerExtra,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Right-aligned header content -- an action button, a count. */
  headerExtra?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Entrance only; the unmount model has no exit frame to animate, and a
    // mount-state helper to fake one is machinery the plan defers until an
    // animation actually needs it.
    <div className="flex h-full flex-col bg-white motion-safe:animate-panel-in dark:bg-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <BackButton onClick={onClose} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {title}
        </span>
        {headerExtra}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * A titled block inside a Panel's scrolling body -- Settings, Friends and
 * GroupDetails had each built this separately (Settings' `Section`,
 * Friends' `Group`, GroupDetails' inline `<section>`s), agreeing on the
 * shape but drifting on the details (border side, padding, heading case).
 * Settings' version is what survives here. A row count or similar belongs
 * in the title string itself (e.g. `"Contacts (3)"`) rather than a second
 * prop -- the caller already has the number.
 */
export function PanelSection({
  title,
  description,
  children,
}: {
  title: string;
  // ReactNode rather than string so a description can style one word --
  // Settings marks the @handle mono without a second description slot.
  description?: ReactNode;
  children: ReactNode;
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

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * An initials avatar with a hue derived from the user id.
 *
 * Deterministic on purpose: the same person is the same colour on every
 * device and every day, with nothing stored anywhere -- the id is the seed.
 * oklch keeps every hue at the same perceived lightness, so no one's colour
 * is unreadably light or dark in either scheme.
 *
 * `hue` overrides the derivation when the person has chosen a colour
 * (users.avatar_hue) -- same formula, so a chosen hue and a derived one are
 * indistinguishable in kind. Null and undefined both mean "derive".
 */
/** The id-derived hue -- Avatar's fallback, exported so the Settings
 *  "Default" swatch can paint the exact colour it stands for. */
export function derivedHue(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

export function Avatar({
  name,
  userId,
  hue: chosenHue,
  size = "md",
  className,
}: {
  name: string;
  userId: string;
  hue?: number | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const hue = chosenHue ?? derivedHue(userId);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

  const sizes = {
    sm: "h-6 w-6 text-[10px]",
    md: "h-10 w-10 text-sm",
    lg: "h-14 w-14 text-lg",
  } as const;

  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        sizes[size],
        className,
      )}
      style={{ backgroundColor: `oklch(0.55 0.13 ${hue})` }}
    >
      {initials || "?"}
    </span>
  );
}

/**
 * The standing public-class label -- every surface a public hub channel has,
 * per the rule-1/9 amendment, pasted identically in the thread header and
 * the hub sidebar row before this.
 */
export function PublicPill() {
  return (
    <span className="shrink-0 rounded-full border border-neutral-300 px-1.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      Public
    </span>
  );
}

/** The unread-count pill. */
export function Badge({
  count,
  label,
  className,
}: {
  count: number;
  /** Screen-reader text; falls back to "N unread". */
  label?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label ?? `${count} unread`}
      className={cx(
        "shrink-0 rounded-full bg-accent-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white",
        className,
      )}
    >
      {count > 98 ? "99+" : count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * A promise-based stand-in for window.confirm, which some embedded and
 * automated environments auto-dismiss and which never matched the app's
 * look. Usage:
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await confirm({ message: "Ban them?" }))) return;
 *   ...
 *   return <>...{confirmDialog}</>;
 *
 * One dialog per component; a second confirm() while one is open settles
 * the first as cancelled, which is also what unmounting does.
 */
export function useConfirm(): {
  confirm: (options: {
    message: string;
    confirmLabel?: string;
  }) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [pending, setPending] = useState<{
    message: string;
    confirmLabel: string;
  } | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    resolver.current?.(answer);
    resolver.current = null;
    setPending(null);
  }, []);

  const confirm = useCallback(
    (options: { message: string; confirmLabel?: string }) => {
      resolver.current?.(false);
      setPending({
        message: options.message,
        confirmLabel: options.confirmLabel ?? "Confirm",
      });
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    },
    [],
  );

  // Escape cancels the dialog and must not also close the Panel underneath:
  // Panel listens on the document bubble phase, so a capture-phase listener
  // that stops propagation gets there first.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        settle(false);
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKey, { capture: true });
  }, [pending, settle]);

  const confirmDialog = pending ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => settle(false)}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.message}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xs rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
      >
        <p className="text-sm text-neutral-900 dark:text-neutral-100">
          {pending.message}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => settle(true)}
            autoFocus
          >
            {pending.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmDialog };
}

/**
 * The text-input sibling of useConfirm, replacing window.prompt for the
 * same reasons window.confirm was replaced -- and with its return contract
 * kept: resolves to the entered string, or null on cancel, so a call site
 * ports from window.prompt without re-deriving its guards. Enter submits,
 * Escape cancels (capture-phase, same as useConfirm, so the Panel under it
 * stays open). One dialog per component; a second prompt() while one is
 * open settles the first as cancelled, as does unmounting.
 */
export function usePrompt(): {
  prompt: (options: {
    message: string;
    initial?: string;
    confirmLabel?: string;
  }) => Promise<string | null>;
  promptDialog: ReactNode;
} {
  const [pending, setPending] = useState<{
    message: string;
    confirmLabel: string;
  } | null>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<((answer: string | null) => void) | null>(null);

  const settle = useCallback((answer: string | null) => {
    resolver.current?.(answer);
    resolver.current = null;
    setPending(null);
  }, []);

  const prompt = useCallback(
    (options: { message: string; initial?: string; confirmLabel?: string }) => {
      resolver.current?.(null);
      setValue(options.initial ?? "");
      setPending({
        message: options.message,
        confirmLabel: options.confirmLabel ?? "Save",
      });
      return new Promise<string | null>((resolve) => {
        resolver.current = resolve;
      });
    },
    [],
  );

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        settle(null);
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", onKey, { capture: true });
  }, [pending, settle]);

  const promptDialog = pending ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => settle(null)}
      role="presentation"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={pending.message}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          settle(value);
        }}
        className="w-full max-w-xs rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
      >
        <p className="text-sm text-neutral-900 dark:text-neutral-100">
          {pending.message}
        </p>
        <div className="mt-3">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
          />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => settle(null)}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm">
            {pending.confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  ) : null;

  return { prompt, promptDialog };
}
