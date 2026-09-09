// The call's controls — microphone, camera, screen, hang up — in one place
// because there are now two surfaces that need them.
//
// The bar has always had them. The call page needs them too: it is a layer
// *over* the bar (2026-09-08), so a page you could not hang up from would
// be a trap. One component rather than two copies, so a control can never
// exist on one surface and not the other.
//
// **The camera icon means your camera and nothing else.** It used to share
// its glyph with a second button that opened the video stage, and nobody
// could tell which was "send mine" and which was "see theirs" — the stage
// button is gone (the call bar's own preview opens the page now) and this
// row is only ever about what *this* device is doing.

import { useState } from "react";

import { useVoice } from "../../voice/hooks";
import {
  VIDEO_SWITCH_NOTE,
  showsVideoButton,
  videoDisabledReason,
  videoNeedsSwitch,
} from "../../voice/rules";
import { voice, type ScreenSource } from "../../voice/session";
import { ScreenPicker } from "./ScreenPicker";
import {
  IconButton,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  SpeakerIcon,
  VideoIcon,
  VideoOffIcon,
} from "../kit";

export function CallControls({
  dark = false,
  onOpenDevices,
}: {
  /** On the call page, which is a dark surface of its own. */
  dark?: boolean;
  /** The bar owns the device picker's disclosure; the page just hides it. */
  onOpenDevices?: () => void;
}) {
  const state = useVoice();
  const cameraReason = videoDisabledReason(state, "camera");
  const screenReason = videoDisabledReason(state, "screen");
  const tint = dark ? "!text-neutral-300 hover:!text-white" : "";
  // The button that was pressed, kept in state rather than read from a ref
  // during render: the popover anchors to it, and a ref's `current` is not
  // something a render may depend on.
  const [picking, setPicking] = useState<{
    sources: ScreenSource[];
    anchor: HTMLElement;
  } | null>(null);

  /**
   * Share screen, on a transport that has no picker of its own.
   *
   * The ask decides: an empty list means the transport opens something
   * itself (`getDisplayMedia`, the macOS sheet) and the press is the whole
   * gesture, exactly as before. A real list means there is nothing to open
   * — Windows in the shell — so ours goes up and the share waits for a
   * choice. Stopping never asks.
   */
  const onScreenPress = async (anchor: HTMLElement): Promise<void> => {
    if (state.screen.on) {
      await voice.setScreenShareEnabled(false);
      return;
    }
    const sources = await voice.screenSources();
    if (sources.length === 0) {
      await voice.toggleScreenShare();
      return;
    }
    setPicking({ sources, anchor });
  };

  return (
    <div
      className={`flex items-center justify-center gap-2 ${
        dark ? "border-t border-neutral-800 px-3 py-3" : ""
      }`}
    >
      <IconButton
        label={state.micMuted ? "Unmute microphone" : "Mute microphone"}
        onClick={() => void voice.toggleMic()}
        aria-pressed={state.micMuted}
        className={
          state.micMuted ? "text-red-600 dark:text-red-400" : tint
        }
      >
        {state.micMuted ? <MicOffIcon /> : <MicIcon />}
      </IconButton>

      {showsVideoButton(state, "camera") && (
        <IconButton
          label={state.camera.on ? "Turn camera off" : "Turn camera on"}
          // On a transport that cannot do video the press *is* the engine
          // switch (rules.ts's videoNeedsSwitch); the hover text says so.
          title={
            cameraReason ?? (videoNeedsSwitch(state, "camera") ? VIDEO_SWITCH_NOTE : undefined)
          }
          disabled={cameraReason !== null}
          onClick={() => void voice.toggleCamera()}
          aria-pressed={state.camera.on}
          className={
            cameraReason
              ? "cursor-not-allowed opacity-40"
              : state.camera.on
                ? "text-accent-600 dark:text-accent-400"
                : tint
          }
        >
          {state.camera.on ? <VideoIcon /> : <VideoOffIcon />}
        </IconButton>
      )}

      {showsVideoButton(state, "screen") && (
        <IconButton
          label={state.screen.on ? "Stop sharing screen" : "Share screen"}
          title={
            screenReason ?? (videoNeedsSwitch(state, "screen") ? VIDEO_SWITCH_NOTE : undefined)
          }
          disabled={screenReason !== null}
          onClick={(event) => void onScreenPress(event.currentTarget)}
          aria-pressed={state.screen.on}
          className={
            screenReason
              ? "cursor-not-allowed opacity-40"
              : state.screen.on
                ? "text-accent-600 dark:text-accent-400"
                : tint
          }
        >
          <ScreenShareIcon />
        </IconButton>
      )}

      {picking && (
        <ScreenPicker
          sources={picking.sources}
          anchor={picking.anchor}
          onCancel={() => setPicking(null)}
          onConfirm={(choice) => {
            setPicking(null);
            void voice.setScreenShareEnabled(true, choice);
          }}
        />
      )}

      {onOpenDevices && (
        <IconButton label="Audio devices" onClick={onOpenDevices} className={tint}>
          <SpeakerIcon />
        </IconButton>
      )}

      <IconButton
        label={state.kind === "room" ? "Leave room" : "Hang up"}
        onClick={() => void voice.leave()}
        className="rounded-full bg-red-600 !text-white hover:!text-white hover:bg-red-700"
      >
        <PhoneOffIcon />
      </IconButton>
    </div>
  );
}
