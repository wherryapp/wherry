// Settings → Voice: the join-mute preference, the ringtone switch, default
// devices, and a microphone meter that proves the device works before a
// call depends on it. All device-local (voice/prefs.ts).

import { useEffect, useRef, useState } from "react";
import { Button, Select } from "../kit";
import {
  listAudioDevices,
  mediaSupported,
  onDeviceChange,
  supportsSpeakerSelection,
  type AudioDevices,
} from "../../voice/devices";
import { useVoicePrefs } from "../../voice/hooks";
import { saveVoicePrefs } from "../../voice/prefs";
import {
  AUDIO_QUALITY_KBPS,
  isAudioQuality,
  type AudioQuality,
  type JoinMutePreference,
} from "../../voice/rules";

/** The tiers in ascending order, with the words the picker shows. */
const QUALITY_LABELS: Readonly<Record<AudioQuality, string>> = {
  telephone: "Telephone",
  speech: "Speech (default)",
  music: "Music",
  musicHighQuality: "High quality",
};

export function VoiceSettings({
  canChooseQuality,
}: {
  /**
   * The `voice_quality` flag: off for everyone by default, on per account.
   * The first plan-gated control -- a future paid tier is the flag with an
   * entitlement behind it -- so the picker is hidden rather than disabled
   * when it is off; nobody is shown a setting they cannot change.
   */
  canChooseQuality: boolean;
}) {
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

  if (!mediaSupported()) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        This browser does not expose a microphone to web apps, so calls are not available here.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
        Joining a voice room
        <Select
          value={prefs.joinMute}
          onChange={(e) => saveVoicePrefs({ joinMute: e.target.value as JoinMutePreference })}
        >
          <option value="auto">Automatic — follow the room's threshold</option>
          <option value="unmuted">Always join unmuted</option>
          <option value="muted">Always join muted</option>
        </Select>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Calls you start or answer always join unmuted.
        </span>
      </label>

      {canChooseQuality && (
        <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          Call audio quality
          <Select
            value={prefs.audioQuality}
            onChange={(e) => {
              const value = e.target.value;
              if (isAudioQuality(value)) saveVoicePrefs({ audioQuality: value });
            }}
          >
            {(Object.keys(AUDIO_QUALITY_KBPS) as AudioQuality[]).map((tier) => (
              <option key={tier} value={tier}>
                {QUALITY_LABELS[tier]} — {AUDIO_QUALITY_KBPS[tier]} kbps
              </option>
            ))}
          </Select>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            What this device sends; each person hears the other's choice.
            Applies to the next call you join. Higher tiers use more data and
            battery.
          </span>
        </label>
      )}

      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={prefs.ringtone}
          onChange={(e) => saveVoicePrefs({ ringtone: e.target.checked })}
          className="h-4 w-4"
        />
        Play a sound for incoming calls
      </label>

      <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
        Microphone
        <Select
          value={prefs.micDeviceId ?? ""}
          onChange={(e) => saveVoicePrefs({ micDeviceId: e.target.value || null })}
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
        <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          Speaker
          <Select
            value={prefs.speakerDeviceId ?? ""}
            onChange={(e) => saveVoicePrefs({ speakerDeviceId: e.target.value || null })}
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

      <MicMeter deviceId={prefs.micDeviceId} onDevicesNamed={() => void listAudioDevices().then(setDevices)} />
    </div>
  );
}

/** Five seconds of level, so "is my mic working?" has an answer here. */
function MicMeter({
  deviceId,
  onDevicesNamed,
}: {
  deviceId: string | null;
  onDevicesNamed: () => void;
}) {
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const test = async (): Promise<void> => {
    stopRef.current?.();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      // Labels are unlocked by the first granted prompt; refresh the lists.
      onDevicesNamed();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const v of buffer) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 4));
      }, 80);
      const stop = (): void => {
        clearInterval(timer);
        for (const track of stream.getTracks()) track.stop();
        void context.close();
        setLevel(null);
        stopRef.current = null;
      };
      stopRef.current = stop;
      setTimeout(stop, 5_000);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone access was refused. Allow it in the browser's site settings."
          : "The microphone could not be started.",
      );
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => void test()} disabled={level !== null}>
          {level === null ? "Test microphone" : "Listening…"}
        </Button>
        <div
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((level ?? 0) * 100)}
          className="h-2 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-700"
        >
          <div
            className="h-full bg-emerald-500 transition-[width] duration-75"
            style={{ width: `${Math.round((level ?? 0) * 100)}%` }}
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
