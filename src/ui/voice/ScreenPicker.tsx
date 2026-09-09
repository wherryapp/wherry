// Our own screen picker, for the platform that has none.
//
// Every other surface has one already: `getDisplayMedia` opens Chromium's
// in a browser, and macOS opens the system sheet. Windows under WebView2
// opens neither -- no picker appears and `getDisplayMedia` never settles
// (regression row S-00) -- so the shell enumerates the displays and windows
// itself (`voice_screen_sources`) and this draws them.
//
// Three things it is deliberately *not*:
//
// - Not gated on a platform. It opens exactly when the transport's
//   `screenSources()` came back non-empty, which is the seam's way of
//   saying "there is no picker to open for you". A transport that grows
//   one later needs no change here.
// - Not a thumbnail grid. libwebrtc's capturer lists ids and titles;
//   thumbnails are a second capture per source and a later nicety.
// - Not where the audio *mode* is decided. The checkbox says yes or no;
//   what "yes" captures follows the source, and both that decision and the
//   sentence describing it are pure and live in transport-rules.ts.

import { useMemo, useState } from "react";

import { screenAudioNote } from "../../voice/transport-rules";
import type { ScreenChoice, ScreenSource } from "../../voice/session";
import { Button, Popover } from "../kit";

/**
 * A display's title from libwebrtc is whatever the platform gave it, which
 * on Windows is often an empty string or a bare index. Numbering them in
 * the order they were enumerated is the honest fallback, and it is a
 * display decision rather than a capture one, which is why it is here and
 * not in the shell.
 */
function labelFor(source: ScreenSource, index: number): string {
  const title = source.title.trim();
  if (title && !/^\d+$/.test(title)) return title;
  return source.isScreen ? `Screen ${index + 1}` : `Window ${index + 1}`;
}

export function ScreenPicker({
  sources,
  anchor,
  onConfirm,
  onCancel,
}: {
  sources: ScreenSource[];
  /** The button the popover hangs off on desktop. */
  anchor: HTMLElement | null;
  onConfirm: (choice: ScreenChoice) => void;
  onCancel: () => void;
}) {
  const screens = useMemo(() => sources.filter((s) => s.isScreen), [sources]);
  const windows = useMemo(() => sources.filter((s) => !s.isScreen), [sources]);
  // Derived rather than corrected in an effect: a source can vanish between
  // the list being drawn and somebody choosing -- the window was closed --
  // and falling back during render means no id the shell would refuse is
  // ever held, and no second render to hold it.
  const [chosen, setChosen] = useState<string | null>(null);
  const selected =
    chosen !== null && sources.some((s) => s.id === chosen) ? chosen : (sources[0]?.id ?? "");
  // Ticked by default: the option exists to be offered, and unticking is
  // one click (the maintainer's decision 3, screen-audio-handoff.md §9).
  const [audio, setAudio] = useState(true);

  const group = (title: string, list: ScreenSource[], offset: number) =>
    list.length === 0 ? null : (
      <div className="mb-2">
        <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {title}
        </div>
        <ul className="space-y-0.5">
          {list.map((source, index) => (
            <li key={source.id}>
              <button
                type="button"
                onClick={() => setChosen(source.id)}
                aria-pressed={selected === source.id}
                className={`w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                  selected === source.id
                    ? "bg-accent-600 text-white"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                {labelFor(source, offset + index)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <Popover anchor={anchor} onClose={onCancel} label="Choose what to share">
      <div className="w-72 max-w-full p-2">
        <div className="max-h-64 overflow-y-auto">
          {group("Screens", screens, 0)}
          {group("Windows", windows, 0)}
        </div>

        <label className="mt-2 flex items-start gap-2 border-t border-neutral-200 px-2 pt-2 dark:border-neutral-800">
          <input
            type="checkbox"
            checked={audio}
            onChange={(event) => setAudio(event.target.checked)}
            className="mt-0.5"
          />
          <span className="text-sm">
            Share audio
            <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
              {selected ? screenAudioNote(selected) : "Choose something to share first."}
            </span>
          </span>
        </label>

        <div className="mt-3 flex justify-end gap-2 px-2 pb-1">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!selected}
            onClick={() => onConfirm({ sourceId: selected, audio })}
          >
            Share
          </Button>
        </div>
      </div>
    </Popover>
  );
}
