// The avatar-colour swatch row: a "Default" swatch painted the exact colour
// the id derives to, then twelve hues 30 degrees apart.
//
// Extracted from Settings on 2026-09-05 when hubs got a colour of their own
// (migration 0028), so the two pickers cannot drift -- the same swatches,
// the same ring, the same "the swatch IS the result" formula from kit's
// Avatar. It knows nothing about what it is colouring: the caller says what
// id derives the default and what to do with a pick.

import { derivedHue } from "./kit";

/** Twelve hues, 30 degrees apart -- the whole wheel with no near-duplicates. */
const SWATCH_HUES = Array.from({ length: 12 }, (_, index) => index * 30);

export function HuePicker({
  seedId,
  hue,
  onPick,
  disabled = false,
}: {
  /** What "Default" derives from -- a user id or a hub id. */
  seedId: string;
  /** The current choice; null is the derived default. */
  hue: number | null;
  onPick: (hue: number | null) => void;
  disabled?: boolean;
}) {
  const ring = (selected: boolean) =>
    selected
      ? "ring-2 ring-accent-600 ring-offset-2 dark:ring-offset-neutral-900"
      : "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label="Default colour"
        title="Default"
        disabled={disabled}
        onClick={() => onPick(null)}
        className={`h-7 w-7 rounded-full ${ring(hue === null)}`}
        // The colour "Default" actually produces for this id, not a grey
        // placeholder -- the swatch is the result.
        style={{ backgroundColor: `oklch(0.55 0.13 ${derivedHue(seedId)})` }}
      />
      {SWATCH_HUES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={`Hue ${swatch} degrees`}
          disabled={disabled}
          onClick={() => onPick(swatch)}
          className={`h-7 w-7 rounded-full ${ring(hue === swatch)}`}
          style={{ backgroundColor: `oklch(0.55 0.13 ${swatch})` }}
        />
      ))}
    </div>
  );
}
