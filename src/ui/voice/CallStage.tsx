// The video surface: a grid of tiles in the thread area, with the pinned
// or shared screen enlarged.
//
// In the thread area rather than over it, and dismissible, because a call
// is not a mode: reading another conversation while somebody's camera is
// on is the ordinary case, and the bar already survives leaving the
// thread. It registers with `useBackLayer` like every other dismissible
// layer, so Android's back gesture closes the stage rather than quitting
// the app (ui/back.ts).
//
// A shared screen auto-pins on arrival, once. Deliberately once: it is the
// right guess the moment somebody starts sharing, and a wrong one to keep
// re-applying over a person who then pinned a face.

import { useEffect, useRef } from "react";
import { useBackLayer } from "../back";
import { useIsDesktop } from "../viewport";
import { IconButton, XIcon } from "../kit";
import { voice, type VoiceParticipant, type VoiceState } from "../../voice/session";
import { VideoTile } from "./VideoTile";

/** One thing to draw: a person's camera, a person's screen, or our own. */
type Tile = {
  key: string;
  identity: string;
  userId: string;
  name: string;
  source: "camera" | "screen";
  self: boolean;
  micMuted: boolean;
  speaking: boolean;
  encrypted: boolean;
  paused: boolean;
};

function tilesOf(state: VoiceState, selfName: string, selfUserId: string): Tile[] {
  const tiles: Tile[] = [];
  if (state.camera.on) {
    tiles.push({
      key: "self/camera",
      identity: "self",
      userId: selfUserId,
      name: `${selfName} (you)`,
      source: "camera",
      self: true,
      micMuted: state.micMuted,
      speaking: false,
      encrypted: state.e2ee,
      paused: state.camera.paused,
    });
  }
  if (state.screen.on) {
    tiles.push({
      key: "self/screen",
      identity: "self",
      userId: selfUserId,
      name: `${selfName} (you)`,
      source: "screen",
      self: true,
      micMuted: state.micMuted,
      speaking: false,
      encrypted: state.e2ee,
      paused: false,
    });
  }
  for (const participant of state.participants) {
    for (const source of ["camera", "screen"] as const) {
      if (!participant[source]) continue;
      tiles.push({
        key: `${participant.identity}/${source}`,
        identity: participant.identity,
        userId: participant.userId,
        name: participant.name,
        source,
        self: false,
        micMuted: participant.micMuted,
        speaking: participant.speaking,
        encrypted: participant.encrypted,
        // A camera turned off, or an app in the background, is a *muted*
        // publication rather than an absent one (livekit-client mutes and
        // stops the device track; only a screen share is unpublished). So
        // the tile stays and says "camera paused", which is what the plan's
        // §2 asked for instead of a frozen last frame.
        paused: source === "camera" && participant.cameraMuted,
      });
    }
  }
  return tiles;
}

function withoutKey({ key: _key, ...rest }: Tile): Omit<Tile, "key"> {
  return rest;
}

/** Whose tile is enlarged: the pin, else the only screen, else nobody. */
function featureOf(tiles: readonly Tile[], pinned: string | null): Tile | null {
  if (pinned) {
    const screen = tiles.find((tile) => tile.identity === pinned && tile.source === "screen");
    if (screen) return screen;
    const camera = tiles.find((tile) => tile.identity === pinned);
    if (camera) return camera;
  }
  return tiles.find((tile) => tile.source === "screen") ?? null;
}

export function CallStage({
  state,
  selfName,
  selfUserId,
  onClose,
}: {
  state: VoiceState;
  selfName: string;
  selfUserId: string;
  onClose: () => void;
}) {
  const isDesktop = useIsDesktop();
  useBackLayer(true, onClose);

  const tiles = tilesOf(state, selfName, selfUserId);
  const featured = featureOf(tiles, state.pinned);
  const rest = featured ? tiles.filter((tile) => tile.key !== featured.key) : tiles;
  // `key` is React's, not a prop: spreading a Tile whole would set it twice.
  const featuredProps = featured ? withoutKey(featured) : null;

  // Auto-pin the first screen that arrives, once per screen. A ref rather
  // than state: this must not re-run when the pin changes, or unpinning a
  // screen would immediately re-pin it.
  const autoPinned = useRef<string | null>(null);
  useEffect(() => {
    const screen = state.participants.find((participant) => participant.screen);
    if (!screen) {
      autoPinned.current = null;
      return;
    }
    if (autoPinned.current === screen.identity) return;
    autoPinned.current = screen.identity;
    voice.pin(screen.identity);
  }, [state.participants]);

  if (tiles.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-neutral-950 p-6 text-sm text-neutral-400">
        <p>Nobody has a camera or a screen on yet.</p>
        <button onClick={onClose} className="text-xs underline">
          Hide video
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col gap-2 overflow-y-auto bg-neutral-950 p-2">
      <IconButton
        label="Hide video"
        onClick={onClose}
        className="absolute right-2 top-2 z-10 rounded bg-black/50 !text-white hover:!text-white"
      >
        <XIcon />
      </IconButton>

      {featured && featuredProps && (
        <VideoTile
          {...featuredProps}
          large
          pinned={state.pinned === featured.identity}
          onPin={() =>
            voice.pin(state.pinned === featured.identity ? null : featured.identity)
          }
        />
      )}

      {rest.length > 0 && (
        <div
          className={`grid gap-2 ${
            isDesktop
              ? featured
                ? "grid-cols-3"
                : rest.length <= 2
                  ? "grid-cols-2"
                  : "grid-cols-3"
              : "grid-cols-2"
          }`}
        >
          {rest.map((tile) => (
            <VideoTile
              key={tile.key}
              {...withoutKey(tile)}
              pinned={state.pinned === tile.identity}
              onPin={() =>
                voice.pin(state.pinned === tile.identity ? null : tile.identity)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export type { VoiceParticipant };
