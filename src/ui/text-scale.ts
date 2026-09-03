// How big the text is, on this device.
//
// Owed since 2026-09-02, when page pinch-zoom was turned off on coarse
// pointers: that gesture was never a working text-size control (the shell is
// fixed-position and sized to the visual viewport, so zooming cropped the app
// rather than reflowing it -- ui/zoom.ts is honest about this), but it was
// the only way to make anything bigger on a phone, and removing it without a
// replacement left nothing at all.
//
// The mechanism is one number: the root font size. Tailwind's utilities are
// rem-based -- `text-sm`, `h-10`, `px-4`, `w-72` are all rem -- so setting
// `html { font-size }` scales the type AND the boxes it sits in, which is
// what keeps a button from staying 40px tall around 23px text. The
// breakpoints do not move with it: a media query's `rem` is resolved against
// the *initial* font size, which the spec fixes at the browser's default
// regardless of what `html` is set to, and ui/viewport.ts's DESKTOP_QUERY is
// in px anyway. So a phone at the largest scale is still a phone.
//
// Device-local, like the sidebar's layout prefs and unlike the avatar colour:
// text size is a fact about this screen and these eyes, not about the
// account. It lives in localStorage rather than IndexedDB because it must be
// applied *before the first paint*, synchronously, from main.tsx -- the same
// reason lockPageZoom() is a startup call.

/** The steps, smallest first. Five is enough to be useful and few enough to
 *  render as a row of buttons on a phone; 1 is the browser default and is
 *  what every account has until it touches this. */
export const TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.45] as const;

export type TextScale = (typeof TEXT_SCALES)[number];

/** The label for each step. Words rather than three As at different sizes:
 *  the buttons are small on a phone, and "Largest" cannot be mistaken for a
 *  serif/sans choice the way a row of As can. */
export const TEXT_SCALE_LABELS: Record<number, string> = {
  0.85: "Smaller",
  1: "Default",
  1.15: "Larger",
  1.3: "Largest",
  1.45: "Huge",
};

export const TEXT_SCALE_KEY = "messenger.textScale";

/** The browser default, and the size every rem in the app is expressed
 *  against. Not read from the document on purpose -- see applyTextScale. */
export const BASE_FONT_PX = 16;

/**
 * Whatever was stored, reduced to a scale we actually have.
 *
 * Anything unrecognised -- a hand-edited key, a value from a future build
 * with more steps, a number that is close but not equal -- reads as 1 rather
 * than being clamped to the nearest step. A wrong-but-plausible size is
 * harder to explain than the default, and this is the value the app renders
 * at before anybody has touched anything.
 */
export function clampScale(value: unknown): TextScale {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return 1;
  const match = TEXT_SCALES.find((scale) => scale === numeric);
  return match ?? 1;
}

/** The next step in a direction, for a keyboard shortcut or a stepper later.
 *  Saturates at the ends rather than wrapping -- wrapping from Huge back to
 *  Smaller is never what somebody pressing "bigger" meant. */
export function stepScale(current: TextScale, direction: 1 | -1): TextScale {
  const index = TEXT_SCALES.indexOf(current);
  const next = Math.min(
    TEXT_SCALES.length - 1,
    Math.max(0, (index === -1 ? 1 : index) + direction),
  );
  return TEXT_SCALES[next]!;
}

/** The root font size a scale means, in CSS pixels. */
export function rootFontSize(scale: TextScale): string {
  return `${BASE_FONT_PX * scale}px`;
}

/**
 * Reads the stored scale. Never throws: Safari in private mode and a
 * browser set to block site data both make `localStorage` itself throw on
 * access, and the app has to render at the default rather than not at all.
 */
export function storedScale(): TextScale {
  try {
    return clampScale(window.localStorage.getItem(TEXT_SCALE_KEY));
  } catch {
    return 1;
  }
}

/**
 * Applies a scale to the document and remembers it.
 *
 * Called once from main.tsx before the first render, and again from the
 * control in Settings on every tap -- the second call is what makes the
 * choice visible immediately rather than on the next load. Writing is
 * best-effort for the same reason reading is.
 */
export function applyTextScale(scale: TextScale): void {
  document.documentElement.style.fontSize = rootFontSize(scale);
  try {
    window.localStorage.setItem(TEXT_SCALE_KEY, String(scale));
  } catch {
    // The size still applies for this session; it just will not survive a
    // reload. Better than refusing to change it at all.
  }
}

/** The startup call: whatever was stored, on the document, before paint. */
export function restoreTextScale(): void {
  applyTextScale(storedScale());
}
