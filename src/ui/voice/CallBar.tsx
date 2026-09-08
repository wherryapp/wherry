// The in-call bar: who is here, whether somebody is showing something,
// the controls, and the way in to the call page.
//
// **Rendered around every screen** (Chat.tsx's `withChrome`, 2026-09-08),
// not just the list/thread split. It used to sit inside the main return,
// after the early returns for Settings, Friends, hub and group panels --
// so opening Settings mid-call made the whole call vanish: no hang-up, no
// mute, no sign there was a call at all. Docked, not floating, on purpose:
// the phone layout has no corner to float in.
//
// **One camera icon, and it means your camera.** There used to be a second
// button with the same glyph that opened the video stage, and nothing told
// the two apart. The way to the video is the bar's own title row and its
// live preview now, both of which say "open the call".

import { useEffect, useState } from "react";
import type { StoredConversation } from "../../store/types";
import { conversationTitle } from "../format";
import { Avatar, Button, LockIcon, MicOffIcon, Select, VideoIcon } from "../kit";
import { CallControls } from "./CallControls";
import { CallPreview } from "./CallPreview";
import { previewTileOf } from "../../voice/rules";
import { useIsDesktop } from "../viewport";
import { listAudioDevices, onDeviceChange, supportsSpeakerSelection, type AudioDevices } from "../../voice/devices";
import { useVoice, useVoicePrefs } from "../../voice/hooks";
import { saveVoicePrefs } from "../../voice/prefs";
import { voice } from "../../voice/session";
import { CallDetails } from "./CallDetails";

function elapsed(since: number | null, now: number): string {
  if (since === null) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CallBar({
  conversations,
  selfUserId,
  onOpenCall,
}: {
  conversations: readonly StoredConversation[];
  selfUserId: string;
  /** Open the call page. The bar never renders video itself beyond the
   *  thumbnail; everything to look at is on that page. */
  onOpenCall: () => void;
}) {
  const state = useVoice();
  const prefs = useVoicePrefs();
  const isDesktop = useIsDesktop();
  const [now, setNow] = useState(() => Date.now());
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (state.phase !== "connected") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state.phase]);

  if (state.phase === "idle") {
    return state.error ? (
      <div
        role="status"
        className="flex items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      >
        <span className="min-w-0 truncate">{state.error}</span>
        <button
          onClick={() => void voice.leave()}
          className="shrink-0 text-xs underline"
        >
          Dismiss
        </button>
      </div>
    ) : null;
  }

  if (state.phase === "elsewhere") {
    return (
      <div className="border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-300">
        In a call in another window.
      </div>
    );
  }

  // Somebody else's live source, if there is one: the thumbnail's subject
  // and, when the preference says `badge`, the thing being counted.
  const preview = previewTileOf(state.participants);
  const liveCount = state.participants.filter(
    (participant) => participant.screen || (participant.camera && !participant.cameraMuted),
  ).length;
  // The thumbnail is a desktop affordance. On a phone the bar is one row
  // for a title, a roster, five controls and this -- and the title is the
  // first thing squeezed out, which at 375px left the bar reading "R"
  // instead of who you are talking to. Below `md` the badge carries the
  // same message in a quarter of the width, and the call page is a tap
  // away for the picture itself.
  const showThumbnail =
    isDesktop &&
    prefs.videoPreview === "thumbnail" &&
    preview !== null &&
    state.capabilities.renderVideo;

  const conversation = conversations.find((c) => c.id === state.conversationId);
  const title = conversation ? conversationTitle(conversation, selfUserId) : "Call";
  const status =
    state.phase === "connecting"
      ? (state.error ?? "Connecting…")
      : state.phase === "reconnecting"
        ? "Reconnecting…"
        : state.ringing
          ? "Calling…"
          : elapsed(state.connectedAt, now);

  return (
    <div className="border-b border-accent-200 bg-accent-50 px-3 py-2 dark:border-accent-900 dark:bg-accent-950">
      {/*
        Wrapping, and the title with a floor under it. At 375px a title, a
        roster, an indicator and five controls do not fit on one line, and
        what a single flex row gives up first is the flexible child -- so
        the bar read "R…" instead of who the call was with. The controls
        drop to their own line instead, which is what a phone has room for.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/*
          The whole title block is the door to the call page. A row of text
          that opens something has to be a real button or a keyboard never
          reaches it -- and this one carries the call's own name, which is
          the honest label for where it goes.
        */}
        <button
          type="button"
          onClick={onOpenCall}
          aria-label={`Open the call — ${title}`}
          className="min-w-[7rem] flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            <span className="min-w-0 truncate">{title}</span>
            {state.e2ee ? (
              <LockIcon
                className="h-3.5 w-3.5 shrink-0 text-accent-600 dark:text-accent-400"
              />
            ) : (
              <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                Not end-to-end encrypted
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
            {status}
            {state.quality === "poor" && " · poor connection"}
            {state.quality === "lost" && " · connection lost"}
          </span>
        </button>

        <div className="flex min-w-0 items-center -space-x-1.5">
          {state.participants.map((participant) => (
            <span
              key={participant.identity}
              title={`${participant.name}${participant.micMuted ? " (muted)" : ""}`}
              className={`relative rounded-full ring-2 ring-offset-1 ring-offset-accent-50 dark:ring-offset-accent-950 ${
                participant.speaking
                  ? "ring-emerald-500"
                  : "ring-transparent"
              }`}
            >
              <Avatar size="sm" name={participant.name} userId={participant.userId} />
              {participant.micMuted && (
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white p-px text-neutral-500 dark:bg-neutral-900">
                  <MicOffIcon className="h-3 w-3" />
                </span>
              )}
            </span>
          ))}
        </div>

        {showThumbnail && preview && (
          <CallPreview
            identity={preview.identity}
            name={preview.name}
            source={preview.source}
            onOpen={onOpenCall}
          />
        )}
        {/*
          The badge is hidden on a transport that cannot render video, for
          the same reason the thumbnail is: it would invite somebody to a
          page with nothing on it. The bar already says the true thing in
          that case -- the line and the switch below.
        */}
        {!showThumbnail && liveCount > 0 && state.capabilities.renderVideo && (
          <button
            type="button"
            onClick={onOpenCall}
            aria-label={`Open the call — ${liveCount} showing video`}
            className="flex shrink-0 items-center gap-1 rounded-full bg-accent-600 px-2 py-1 text-xs font-medium text-white"
          >
            <VideoIcon className="h-3.5 w-3.5" />
            {liveCount}
          </button>
        )}

        <div className="ml-auto flex items-center gap-3">
          <CallControls onOpenDevices={() => setDevicesOpen((open) => !open)} />
        </div>
      </div>

      {state.playbackBlocked && (
        <div className="mt-2">
          <Button size="sm" onClick={() => void voice.startAudio()}>
            Tap to hear the call
          </Button>
        </div>
      )}

      {state.error && state.phase === "connected" && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{state.error}</p>
      )}

      {/*
        The desktop shell's own media engine has no camera capture and no
        way to put a received frame on screen (video's stage 3N is what
        changes that), so somebody who wants video here rejoins this one
        call through the webview engine. One reconnect -- a second or two
        of silence -- and their `nativeMedia` preference is untouched,
        because they did not change their mind about audio.
      */}
      {!state.capabilities.renderVideo &&
        state.phase === "connected" &&
        state.engineOverride === null &&
        (state.grant?.sources.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-600 dark:text-neutral-300">
              {state.participants.some((p) => p.camera || p.screen)
                ? "Somebody has video on, and this device's audio engine cannot show it."
                : "Video runs through the browser engine on this device."}
            </span>
            <Button size="sm" onClick={() => void voice.switchEngineForThisCall()}>
              Switch engine for this call
            </Button>
          </div>
        )}

      {devicesOpen && <DevicePicker onClose={() => setDevicesOpen(false)} />}

      <div className="flex flex-wrap gap-x-4">
        {state.participants.length > 0 && (
          <VolumeList participants={state.participants} />
        )}
        <button
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          className="mt-1 text-xs text-neutral-500 underline dark:text-neutral-400"
        >
          {detailsOpen ? "Hide details" : "Details"}
        </button>
      </div>
      {detailsOpen && <CallDetails />}
    </div>
  );
}

function DevicePicker({ onClose }: { onClose: () => void }) {
  const prefs = useVoicePrefs();
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void listAudioDevices().then((list) => {
        if (!cancelled) setDevices(list);
      });
    };
    load();
    const off = onDeviceChange(load);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <label className="text-xs text-neutral-600 dark:text-neutral-300">
        Microphone
        <Select
          value={prefs.micDeviceId ?? ""}
          onChange={(e) => {
            const id = e.target.value || null;
            saveVoicePrefs({ micDeviceId: id });
            if (id) void voice.setMicDevice(id);
          }}
          className="mt-1 w-full"
        >
          <option value="">Default</option>
          {devices.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </Select>
      </label>
      {supportsSpeakerSelection() && (
        <label className="text-xs text-neutral-600 dark:text-neutral-300">
          Speaker
          <Select
            value={prefs.speakerDeviceId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              saveVoicePrefs({ speakerDeviceId: id });
              if (id) void voice.setSpeakerDevice(id);
            }}
            className="mt-1 w-full"
          >
            <option value="">Default</option>
            {devices.outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      <button
        onClick={onClose}
        className="justify-self-start text-xs text-neutral-500 underline dark:text-neutral-400"
      >
        Done
      </button>
    </div>
  );
}

/** Per-person volume: a client-side gain on their track, nothing sent. */
function VolumeList({
  participants,
}: {
  participants: readonly { userId: string; identity: string; name: string; volume: number }[];
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1 text-xs text-neutral-500 underline dark:text-neutral-400"
      >
        Volumes
      </button>
    );
  }
  return (
    <div className="mt-2 grid gap-1">
      {participants.map((p) => (
        <label key={p.identity} className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <span className="w-24 truncate">{p.name}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={p.volume}
            onChange={(e) => voice.setVolume(p.userId, Number(e.target.value))}
            aria-label={`Volume for ${p.name}`}
            className="flex-1"
          />
        </label>
      ))}
      <button
        onClick={() => setOpen(false)}
        className="justify-self-start text-xs text-neutral-500 underline dark:text-neutral-400"
      >
        Hide volumes
      </button>
    </div>
  );
}
