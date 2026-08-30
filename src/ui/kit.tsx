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

import { useEffect, type ReactNode } from "react";

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

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BUTTON_VARIANTS = {
  /** The one action a screen is for. */
  primary:
    "bg-neutral-900 text-white disabled:opacity-50 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300",
  /** Everything beside it. */
  secondary:
    "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800",
  /** Destructive, and styled to look it before it is pressed. */
  danger:
    "border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  /** Text that acts. The header links and row actions. */
  ghost:
    "text-neutral-500 hover:text-neutral-800 disabled:opacity-50 dark:hover:text-neutral-200",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: "md" | "sm";
  className?: string;
} & React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cx(
        "rounded-md text-sm font-medium transition-colors",
        // Ghost buttons are text, not boxes; padding would misalign them
        // with the labels they sit beside.
        variant !== "ghost" && (size === "md" ? "px-3 py-2" : "px-3 py-1.5"),
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    />
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
        "rounded p-1.5 text-neutral-500 transition-colors hover:text-neutral-900 dark:hover:text-neutral-100",
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

/** Inline problem text, next to the thing that failed. */
export function ErrorText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cx("text-xs text-red-600 dark:text-red-400", className)}>
      {children}
    </p>
  );
}

/** Inline confirmation or context, same slot as ErrorText. */
export function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cx("text-xs text-neutral-600 dark:text-neutral-300", className)}
    >
      {children}
    </p>
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
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
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
 */
export function Avatar({
  name,
  userId,
  size = "md",
  className,
}: {
  name: string;
  userId: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;

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
