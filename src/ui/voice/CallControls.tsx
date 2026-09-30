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

import { useEffect, useState } from "react";

import { listVideoDevices } from "../../voice/devices";
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

/**
 * How many cameras the live engine can open, read while the camera is on
 * (null while it is off, or not read yet). The flip exists only for two or
 * more; a laptop with one never sees it.
 */
function useCameraCount(on: boolean, native: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!on) {
      setCount(null);
      return;
    }
    let cancelled = false;
    void listVideoDevices(native).then((list) => {
      if (!cancelled) setCount(list.length);
    });
    return () => {
      cancelled = true;
    };
  }, [on, native]);
  return count;
}

/** Two arrows chasing each other around a camera body: "the other camera". */
function FlipCameraIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M3 7.5A2 2 0 0 1 5 5.5h1.5l1.2-1.5h4.6l1.2 1.5H15a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M7.4 9.6a2.8 2.8 0 0 1 4.9-.8" />
      <path d="m12.6 7.4-.3 1.4-1.4-.3" />
      <path d="M12.6 11.4a2.8 2.8 0 0 1-4.9.8" />
      <path d="m7.4 13.6.3-1.4 1.4.3" />
    </svg>
  );
}

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
  // The flip: a phone's way to its back camera (row A-38), and a laptop's to
  // a second camera, without a trip through Settings. Only while the camera
  // is on and there is another to move to. This row sits under the stage,
  // never over a tile, so a native tile's swallowed pointer is not in its
  // way (rules.ts's `tilesDrawAbovePage`).
  const cameras = useCameraCount(state.camera.on && !state.camera.paused, state.nativeEngine);
  const showsFlip = state.camera.on && !state.camera.paused && (cameras ?? 0) >= 2;
  // The button that was pressed, kept in state rather than read from a ref
  // during render: the popover anchors to it, and a ref's `current` is not
  // something a render may depend on.
  const [picking, setPicking] = useState<{
    sources: ScreenSource[];
    anchor: HTMLElement;
  } | null>(null);

  /**
   * Share screen, or stop. The session decides (`pressScreenShare`, the
   * same decision the keyboard shortcut in `Chat.tsx` takes): sources come
   * back only where the transport has no picker of its own — Windows in
   * the shell — and then ours goes up, anchored to this button, and the
   * share waits for a choice.
   */
  const onScreenPress = async (anchor: HTMLElement): Promise<void> => {
    const sources = await voice.pressScreenShare();
    if (sources) setPicking({ sources, anchor });
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
          // Where this transport cannot capture *this source*, the press
          // *is* the engine switch (rules.ts's videoNeedsSwitch); the
          // hover text says so. Per source, not per transport: a Windows
          // shell built between W3 and W4 shares a screen in place and
          // still switches for a camera.
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

      {showsFlip && (
        <IconButton
          label="Switch camera"
          onClick={() => void voice.flipCamera()}
          className={tint}
        >
          <FlipCameraIcon />
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
