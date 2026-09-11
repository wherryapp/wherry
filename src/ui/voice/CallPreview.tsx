// The call bar's live thumbnail: proof that somebody's video is really on,
// and the way in to the call page.
//
// It exists because a badge cannot answer the question people actually
// have — *is their camera working?* — and because the call page needs an
// obvious door. Pressing anywhere on it opens the page.
//
// **It subscribes as a `preview`**, which `session.ts` translates into the
// low layer whatever the source is (`rules.ts`'s `subscriptionFor`). A
// screen share at 96 pixels wide must not pull full resolution, and
// without that distinction it would: screens are otherwise always asked
// for at `high`, because text in a shared window is unreadable below it.
//
// Somebody on a metered connection turns this into a badge in
// Settings → Voice; `prefs.videoPreview` is the switch and `CallBar`
// decides which of the two to render.
//
// **It stops being a button where the shell draws over the page** (row
// D-45). A native tile covers this whole 64x36 box and swallows the click,
// so pressing it did nothing at all -- the one case in the app where the
// covered thing *was* the control rather than sitting beside it. The bar's
// title row is the other door and is labelled as one, so here the picture
// becomes what it can honestly be: proof that somebody's video is on.

import { useEffect, useRef } from "react";
import { voice } from "../../voice/session";
import type { VideoSource } from "../../voice/rules";

export function CallPreview({
  identity,
  name,
  source,
  above = false,
  onOpen,
}: {
  identity: string;
  name: string;
  source: VideoSource;
  /** The shell draws this thumbnail over the page, so it cannot be pressed
   *  (`rules.ts`'s `tilesDrawAbovePage`). */
  above?: boolean;
  onOpen: () => void;
}) {
  const element = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const detach = voice.attachVideo(identity, source, node, "bar");
    // No IntersectionObserver here, unlike a tile: the bar is one row of
    // chrome that is either rendered or not, and a thumbnail that measured
    // itself would go dark behind the call page — which is exactly when it
    // must keep its subscription, because the page's own tile is using it.
    voice.setTileVisible(identity, source, true, "preview");
    return () => {
      voice.setTileVisible(identity, source, false, "preview");
      detach();
    };
  }, [identity, source]);

  const box =
    "relative h-9 w-16 shrink-0 overflow-hidden rounded bg-neutral-900 ring-1 ring-accent-400/60";

  if (above) {
    return (
      <div
        className={box}
        // A native tile is clipped to this box, the way `overflow-hidden`
        // clips the `<video>` (transport-rules.ts's tileRect).
        data-video-clip=""
        // The name strip is gone rather than moved: in flow it would take a
        // third of a 36px-tall box, and as an overlay it would be under the
        // native window. The roster of avatars beside this in the bar says
        // who is in the call, and the title row opens it.
        aria-hidden="true"
      >
        <video ref={element} muted playsInline autoPlay className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open the call — ${name} is showing their ${
        source === "screen" ? "screen" : "camera"
      }`}
      className={`${box} transition hover:ring-accent-500 focus-visible:ring-2 focus-visible:ring-accent-500`}
      // A native tile is clipped to this button, the way `overflow-hidden`
      // clips the `<video>` (transport-rules.ts's tileRect).
      data-video-clip=""
    >
      <video
        ref={element}
        muted
        playsInline
        autoPlay
        className="h-full w-full object-cover"
      />
      <span className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 text-[0.5rem] leading-3 text-white">
        <span className="block truncate">{name}</span>
      </span>
    </button>
  );
}
