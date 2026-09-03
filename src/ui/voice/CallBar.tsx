// The in-call bar: who is here, whether they are speaking, mute, devices,
// leave. Rendered above the list/thread split so it is visible whichever
// conversation is open -- a call does not end because you read another
// thread. Docked, not floating, on purpose: the phone layout has no
// corner to float in.

import { useEffect, useState } from "react";
import type { StoredConversation } from "../../store/types";
import { conversationTitle } from "../format";
import {
  Avatar,
  Button,
  IconButton,
  LockIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  Select,
  SpeakerIcon,
} from "../kit";
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
}: {
  conversations: readonly StoredConversation[];
  selfUserId: string;
}) {
  const state = useVoice();
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
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
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
        </span>

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

        <IconButton
          label={state.micMuted ? "Unmute microphone" : "Mute microphone"}
          onClick={() => void voice.toggleMic()}
          aria-pressed={state.micMuted}
          className={state.micMuted ? "text-red-600 dark:text-red-400" : ""}
        >
          {state.micMuted ? <MicOffIcon /> : <MicIcon />}
        </IconButton>
        <IconButton
          label="Audio devices"
          onClick={() => setDevicesOpen((open) => !open)}
          aria-expanded={devicesOpen}
        >
          <SpeakerIcon />
        </IconButton>
        <IconButton
          label={state.kind === "room" ? "Leave room" : "Hang up"}
          onClick={() => void voice.leave()}
          className="rounded-full bg-red-600 !text-white hover:!text-white hover:bg-red-700"
        >
          <PhoneOffIcon />
        </IconButton>
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
