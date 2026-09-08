// One participant's video, in one element.
//
// Three things about it are load-bearing and easy to lose:
//
// - **The element is handed to the transport, not filled from a prop.**
//   Adaptive streaming measures the *attached element* to decide which
//   simulcast layer to ask for, so the element has to reach the SDK
//   (voice/transport.ts's `attachVideo`, the one DOM crossing on that
//   seam). A tile that never attaches, or attaches to something 0x0, asks
//   for the lowest layer or pauses -- which is also why a hidden browser
//   pane is a lying instrument for anything about layers.
//
// - **Visibility is reported, not assumed.** An IntersectionObserver tells
//   the session when the tile is really on screen, and the session
//   unsubscribes what nobody can see. That is the whole answer to the
//   decoder limit on a phone and most of the egress answer: a tab with the
//   stage closed pulls no video at all.
//
// - **Data only.** A `<video>` with a `srcObject` and nothing else. Never
//   an iframe, never `srcdoc` -- the same rule FileChip states for
//   attachments, and for the same reason.

import { useEffect, useRef } from "react";
import type { VideoSource } from "../../voice/rules";
import { voice } from "../../voice/session";
import { Avatar, MicOffIcon, PinnedIcon } from "../kit";

export function VideoTile({
  identity,
  userId,
  name,
  source,
  self = false,
  micMuted = false,
  speaking = false,
  encrypted = true,
  paused = false,
  pinned = false,
  large = false,
  onPin,
}: {
  /** The device id, or `"self"` for this device's own preview. */
  identity: string;
  userId: string;
  name: string;
  source: VideoSource;
  self?: boolean;
  micMuted?: boolean;
  speaking?: boolean;
  encrypted?: boolean;
  /** Their camera is on but paused because their app is in the background. */
  paused?: boolean;
  pinned?: boolean;
  large?: boolean;
  onPin?: () => void;
}) {
  const element = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    return voice.attachVideo(identity, source, node);
  }, [identity, source]);

  useEffect(() => {
    const node = element.current;
    // Self is never unsubscribed -- there is nothing to subscribe to, the
    // preview is the local track -- so only a remote tile reports.
    if (!node || self) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer (an old engine, a test): assume visible rather than
      // leave the tile permanently unsubscribed and black.
      voice.setTileVisible(identity, source, true);
      return () => voice.setTileVisible(identity, source, false);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          voice.setTileVisible(identity, source, entry.isIntersecting);
        }
      },
      // A sliver counts: a tile half off the bottom of the stage is one
      // somebody is looking at.
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      voice.setTileVisible(identity, source, false);
    };
  }, [identity, source, self]);

  const label = source === "screen" ? `${name} · screen` : name;

  return (
    <div
      className={`group relative overflow-hidden rounded-lg bg-neutral-900 ${
        large ? "aspect-video" : "aspect-video"
      } ${speaking ? "ring-2 ring-emerald-500" : ""}`}
    >
      <video
        ref={element}
        muted
        playsInline
        autoPlay
        // Mirrored for this device's own camera and never for the published
        // track: a preview that is not mirrored reads as somebody else's
        // face. A screen is never mirrored either way.
        className={`h-full w-full object-contain ${
          self && source === "camera" ? "scale-x-[-1]" : ""
        }`}
      />

      {paused && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-900/80 text-xs text-neutral-300">
          <Avatar size="md" name={name} userId={userId} />
          camera paused
        </span>
      )}

      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 text-xs text-white">
        <span className="min-w-0 truncate">{label}</span>
        {micMuted && <MicOffIcon className="h-3.5 w-3.5 shrink-0" />}
        {!encrypted && (
          <span className="shrink-0 rounded bg-amber-500/90 px-1 py-px text-[0.625rem] font-medium uppercase tracking-wide text-amber-950">
            In the clear
          </span>
        )}
      </span>

      {onPin && (
        <button
          type="button"
          onClick={onPin}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          className="absolute right-1.5 top-1.5 rounded bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <PinnedIcon className={`h-4 w-4 ${pinned ? "text-accent-300" : ""}`} />
        </button>
      )}
    </div>
  );
}
