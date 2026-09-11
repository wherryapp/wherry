// The call page: everything about the call in progress, on its own surface.
//
// **A layer over the whole app, not a panel in the thread.** It was the
// latter until 2026-09-08, and that shape had a defect rather than a
// preference behind it: the stage rendered only while the call's own
// conversation was the selected one, so walking back to the list made the
// video disappear and opening Settings made the entire call disappear --
// bar, hang-up and all. Somebody whose peer turned a camera on while they
// were anywhere else pressed "Show video" and got nothing, which is how it
// was reported. Chat.tsx now renders this and the bar around *every*
// screen, so the call outlives wherever you happen to be.
//
// It registers with `useBackLayer` like every other dismissible layer, so
// Android's back gesture and Escape close it and put the app back exactly
// where it was (ui/back.ts).
//
// A shared screen auto-pins on arrival, once. Deliberately once: it is the
// right guess the moment somebody starts sharing, and a wrong one to keep
// re-applying over a person who then pinned a face.

import { useEffect, useRef } from "react";
import { useBackLayer, useOverlayDepth } from "../back";
import { useIsDesktop } from "../viewport";
import { Button, IconButton, LockIcon, XIcon } from "../kit";
import { CallControls } from "./CallControls";
import { voice, type VoiceState } from "../../voice/session";
import { tilesDrawAbovePage } from "../../voice/rules";
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

/**
 * Whose tile is enlarged: the pin, else the only screen, else — when there
 * is only one thing to look at — that one thing.
 *
 * The last clause is not a special case so much as the absence of a
 * choice: a single tile dropped into the grid took half the width of a
 * page that had nothing else on it, which reads as a layout fault rather
 * than a decision. Two or more go back to the grid, where the sizes carry
 * meaning again.
 */
function featureOf(tiles: readonly Tile[], pinned: string | null): Tile | null {
  if (pinned) {
    const screen = tiles.find((tile) => tile.identity === pinned && tile.source === "screen");
    if (screen) return screen;
    const camera = tiles.find((tile) => tile.identity === pinned);
    if (camera) return camera;
  }
  const screen = tiles.find((tile) => tile.source === "screen");
  if (screen) return screen;
  return tiles.length === 1 ? (tiles[0] ?? null) : null;
}

export function CallPage({
  state,
  title,
  selfName,
  selfUserId,
  onClose,
}: {
  state: VoiceState;
  /** The conversation's name, so the page says which call this is -- it can
   *  now be open over a screen that has nothing to do with it. */
  title: string;
  selfName: string;
  selfUserId: string;
  onClose: () => void;
}) {
  const isDesktop = useIsDesktop();
  const layer = useBackLayer(true, onClose);

  // A native video tile sits above everything the page draws (path (b),
  // src-tauri/src/voice/render.rs), so the page says when something is
  // over it: any overlay registered after this one -- a profile card, the
  // photo viewer, the incoming-call sheet. The decision is the back
  // stack's overlay count against this layer's own position; the transport
  // that has no native tiles ignores the call.
  const overlays = useOverlayDepth();
  useEffect(() => {
    const own = layer.current;
    voice.setSurfaceCovered("page", own !== null && overlays > own + 1);
  }, [overlays, layer]);
  useEffect(() => () => voice.setSurfaceCovered("page", false), []);

  // Escape closes it on a keyboard, the same as back does on a phone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A transport that cannot render video has no tiles to draw, not even
  // dead ones: drawing a `<video>` nothing can ever attach to would be a
  // black rectangle with somebody's name under it. The empty state says
  // the true thing instead, and offers the same way out the bar does.
  //
  // Which transports those are has narrowed twice, so read the capability
  // rather than assuming the engine: the desktop shell's own engine
  // renders on macOS (stage 3N, 2026-09-08) and on Windows (stage W3,
  // 2026-09-10, a child HWND over the page). What Windows still cannot do
  // is open a *camera*, which is a different question and one the buttons
  // ask, not this branch.
  const canRender = state.capabilities.renderVideo;
  const tiles = canRender ? tilesOf(state, selfName, selfUserId) : [];
  const featured = featureOf(tiles, state.pinned);
  const rest = featured ? tiles.filter((tile) => tile.key !== featured.key) : tiles;
  // `key` is React's, not a prop: spreading a Tile whole would set it twice.
  const featuredProps = featured ? withoutKey(featured) : null;
  // Where the shell draws the picture over this page, every tile's chrome
  // moves out from under it: a click there never reaches the page and no
  // hover is ever seen (row D-45). Decided once, here, and passed down --
  // no component asks which transport it got.
  const above = tilesDrawAbovePage(state);

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call — ${title}`}
      className="fixed inset-0 z-40 flex flex-col bg-neutral-950"
      // `fixed inset-0` is positioned against the viewport, which is
      // exactly what escapes the safe-area padding index.css puts on the
      // app root -- so on hardware whose edges are not rectangles the
      // header drew *under* the clock and the Dynamic Island. Seen on the
      // iOS simulator, 2026-09-08; `PhotoViewer` is fixed for the same
      // reason and pays the same tax. The background stays black through
      // the inset strips, which is what a video surface wants anyway.
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      <header className="flex items-center gap-3 border-b border-neutral-800 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
            <span className="min-w-0 truncate">{title}</span>
            {state.e2ee ? (
              <LockIcon className="h-3.5 w-3.5 shrink-0 text-accent-400" />
            ) : (
              <span className="shrink-0 rounded bg-amber-900 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-amber-200">
                Not end-to-end encrypted
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-neutral-400">
            {state.participants.length === 0
              ? "Nobody else here yet"
              : `${state.participants.length + 1} people`}
            {state.quality === "poor" && " · poor connection"}
            {state.quality === "lost" && " · connection lost"}
          </span>
        </span>
        <IconButton
          label="Close the call page"
          onClick={onClose}
          className="!text-neutral-300 hover:!text-white"
        >
          <XIcon />
        </IconButton>
      </header>

      {tiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {canRender ? (
            <>
              <p className="text-sm text-neutral-400">
                Nobody has a camera or a screen on yet.
              </p>
              <p className="max-w-xs text-xs text-neutral-500">
                Turn yours on below, or leave this open — anybody who starts
                will appear here.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-400">
                This device is using its own audio engine, which cannot show
                video.
              </p>
              <p className="max-w-xs text-xs text-neutral-500">
                Switching for this call reconnects it through the browser
                engine — a second or two of silence. Your setting is not
                changed.
              </p>
              {state.engineOverride === null && (
                <Button size="sm" onClick={() => void voice.switchEngineForThisCall()}>
                  Switch engine for this call
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2" data-video-clip="">
          {featured && featuredProps && (
            <div className="min-h-0 flex-1">
              <VideoTile
                {...featuredProps}
                large
                above={above}
                pinned={state.pinned === featured.identity}
                onPin={() =>
                  voice.pin(state.pinned === featured.identity ? null : featured.identity)
                }
              />
            </div>
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
                  above={above}
                  pinned={state.pinned === tile.identity}
                  onPin={() =>
                    voice.pin(state.pinned === tile.identity ? null : tile.identity)
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        The controls live on the page as well as in the bar, because the bar
        is behind this layer: a page you cannot hang up from would be a trap.
      */}
      <CallControls dark />
    </div>
  );
}
