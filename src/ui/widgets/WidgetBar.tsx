// The composer's widget bar: the row of things that put content in a message
// without typing it.
//
// ---------------------------------------------------------------------------
// Why this is a bar and not just a button
// ---------------------------------------------------------------------------
//
// There is exactly one widget today. The bar exists because the composer's
// control row already anticipated more than one ("the row itself has room for
// a mic button beside the attach one"), and because the alternative -- a
// second bespoke button wired directly into Composer.tsx, then a third --
// is how that file got to 780 lines the first time.
//
// The seam is deliberately narrow. A widget is an icon, a label, and a panel
// that opens above the composer; the panel is handed one capability, which is
// "put these files in the composer". That covers a GIF picker and would cover
// stickers or a camera. It does NOT cover a widget that sends a payload kind
// of its own (a poll, say) -- that needs a second capability on the context,
// and the honest thing is to add it when there is one rather than to guess its
// shape now.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { GifIcon } from "../kit";
import { GifPanel } from "./GifPanel";

/** What a widget's panel is allowed to do to the composer. */
export type WidgetContext = {
  /** Adds files as pending attachments, through the composer's one funnel. */
  attach: (files: readonly File[]) => void;
  /** Closes this panel. A widget calls it when its work is done. */
  close: () => void;
};

export type WidgetDefinition = {
  id: string;
  /** The button's accessible name, and its tooltip. */
  label: string;
  icon: ReactNode;
  Panel: (props: { context: WidgetContext }) => ReactNode;
};

/**
 * Every widget, in the order they appear.
 *
 * Adding one is appending an entry. Whether a given widget is *available* is
 * not decided here -- availability is a feature flag or a capability, which
 * the composer knows about and this list does not, so it arrives as the
 * `available` set below.
 */
const WIDGETS: readonly WidgetDefinition[] = [
  {
    id: "gif",
    label: "Send a GIF",
    icon: <GifIcon />,
    Panel: GifPanel,
  },
];

export function WidgetBar({
  available,
  onAttach,
  disabled,
}: {
  /**
   * Which widget ids may be shown. A widget missing from this set renders
   * nothing at all -- not a disabled button, which would advertise a feature
   * this deploy or this account does not have.
   */
  available: ReadonlySet<string>;
  onAttach: (files: readonly File[]) => void;
  /** True while an edit is being composed, when nothing may be attached. */
  disabled?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);

  const widgets = WIDGETS.filter((widget) => available.has(widget.id));

  // Closing on an outside press or on Escape, which is what every other
  // transient panel here does. `pointerdown` rather than `click` so a drag
  // that starts outside also dismisses, and so the panel is gone before the
  // thing underneath receives the press.
  useEffect(() => {
    if (openId === null) return;

    const onPointerDown = (event: PointerEvent): void => {
      const node = container.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpenId(null);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openId]);

  // An edit cannot take attachments, so an open panel has to go when one
  // starts -- otherwise the picker stays up offering something that will be
  // refused the moment it is tapped.
  useEffect(() => {
    if (disabled) setOpenId(null);
  }, [disabled]);

  if (widgets.length === 0 || disabled) return null;

  const open = widgets.find((widget) => widget.id === openId) ?? null;

  return (
    <div ref={container} className="relative flex items-center">
      {widgets.map((widget) => (
        <button
          key={widget.id}
          type="button"
          aria-label={widget.label}
          title={widget.label}
          aria-expanded={openId === widget.id}
          // The caret must not move to this button. Pressing any element
          // takes focus out of the textarea, and on a phone losing focus is
          // the keyboard closing -- the same reason the send button does
          // this. See Composer.tsx's note on keepKeyboardOpen.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            setOpenId((current) => (current === widget.id ? null : widget.id))
          }
          className={
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition motion-safe:active:scale-90 " +
            (openId === widget.id
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
              : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100")
          }
        >
          {widget.icon}
        </button>
      ))}

      {open && (
        // Anchored to the bar and opening upward, because the composer is at
        // the bottom of the screen. The width backs off from the viewport on
        // a phone rather than being a fixed 22rem: the bar sits a button's
        // width in from the left edge, so a panel as wide as the screen would
        // hang off the right of it.
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(22rem,calc(100vw-5rem))]">
          <open.Panel
            context={{
              attach: onAttach,
              close: () => setOpenId(null),
            }}
          />
        </div>
      )}
    </div>
  );
}
