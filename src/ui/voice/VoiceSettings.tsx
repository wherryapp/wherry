// Settings → Voice: the join-mute preference, the ringtone switch, the
// microphone's processing switches, default devices, and a microphone meter
// that proves the device works before a call depends on it. All device-local
// (voice/prefs.ts).

import { useEffect, useRef, useState } from "react";
import { Button, Select } from "../kit";
import {
  listAudioDevices,
  listVideoDevices,
  mediaSupported,
  onDeviceChange,
  supportsSpeakerSelection,
  type AudioDevices,
  type VideoDevice,
} from "../../voice/devices";
import { useNativeMediaAvailable, useVoicePrefs } from "../../voice/hooks";
import { nativeMediaProbe } from "../../voice/native-media";
import { saveVoicePrefs, type VideoQualityTier, type VoicePrefs } from "../../voice/prefs";
import {
  AUDIO_QUALITY_KBPS,
  isAudioQuality,
  type AudioQuality,
  type JoinMutePreference,
} from "../../voice/rules";

/**
 * The three processing switches (docs/prompts/native-media-plan.md §6),
 * with the words the checkboxes show. One setting each; which engine
 * applies it is the transport's business and is named beneath them.
 */
const PROCESSING: readonly {
  key: keyof Pick<VoicePrefs, "echoCancellation" | "noiseSuppression" | "autoGainControl">;
  label: string;
}[] = [
  { key: "echoCancellation", label: "Echo cancellation" },
  { key: "noiseSuppression", label: "Noise suppression" },
  { key: "autoGainControl", label: "Automatic gain control" },
];

/**
 * Who applies the switches -- the honest half of "one echo canceller on
 * every desktop". The shell's probe names its implementation (WebRTC's
 * software module, on every desktop); a browser names nothing and each one
 * has its own.
 */
function processingEngine(native: boolean): string {
  if (!native) return "Applied by the browser, with its own canceller, suppressor and gain control.";
  const probe = nativeMediaProbe();
  const software = probe?.aec === "Software" || probe?.aec === undefined;
  return software
    ? "Applied by the app's own audio engine: WebRTC's software processing, the same on every desktop."
    : `Applied by the app's own audio engine (${probe?.aec ?? "unknown"} echo canceller).`;
}

/** The tiers in ascending order, with the words the picker shows. */
const QUALITY_LABELS: Readonly<Record<AudioQuality, string>> = {
  telephone: "Telephone",
  speech: "Speech (default)",
  music: "Music",
  musicHighQuality: "High quality",
};

/** The camera tiers, in ascending order, with the words the picker shows. */
const VIDEO_QUALITY_LABELS: Readonly<Record<VideoQualityTier, string>> = {
  standard: "Standard — 360p, easiest on battery and data",
  auto: "Automatic — up to 720p (default)",
  hd: "High — whatever this call allows",
};

export function VoiceSettings({
  canChooseQuality,
  cameraLimit,
}: {
  /**
   * The `voice_quality` flag: off for everyone by default, on per account.
   * The first plan-gated control -- a future paid tier is the flag with an
   * entitlement behind it -- so the picker is hidden rather than disabled
   * when it is off; nobody is shown a setting they cannot change.
   */
  canChooseQuality: boolean;
  /**
   * This account's camera ceiling outside any hub, from
   * `/account/settings`'s `videoLimits`. Null means no camera anywhere --
   * the flag is off, or a policy row withheld it -- and the whole camera
   * section is hidden rather than shown failing. Advisory in exactly the
   * way the flag is: the per-call token is what actually decides.
   */
  cameraLimit: { maxHeight: number; maxFps: number } | null;
}) {
  const prefs = useVoicePrefs();
  const nativeAvailable = useNativeMediaAvailable();
  /** The engine is here and this device chose it: the lists below come
   *  from the shell, and the browser's microphone test does not apply. */
  const native = nativeAvailable && prefs.nativeMedia;
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
    // Re-read when the engine flips: the two id spaces do not overlap.
  }, [native]);

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

      {nativeAvailable && (
        <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
          <input
            type="checkbox"
            checked={prefs.nativeMedia}
            onChange={(e) => saveVoicePrefs({ nativeMedia: e.target.checked })}
            className="mt-0.5 h-4 w-4"
          />
          <span className="grid gap-1">
            <span>Use the app's own audio engine</span>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Captures and plays call audio in the app itself rather than in the
              web view: one echo canceller on every desktop, devices by name, and
              a microphone the app owns. Applies to the next call you join.
            </span>
          </span>
        </label>
      )}

      <fieldset className="grid gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <legend className="mb-1">Microphone processing</legend>
        {PROCESSING.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={prefs[key]}
              onChange={(e) => saveVoicePrefs({ [key]: e.target.checked })}
              className="h-4 w-4"
            />
            {label}
          </label>
        ))}
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {processingEngine(native)} Applies to the next call you join. With
          headphones there is no echo to cancel and cancellation can only colour
          your voice, so turn it off; turn noise suppression off for music.
        </span>
      </fieldset>

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

      {cameraLimit && <CameraSection tier={prefs.videoQuality} deviceId={prefs.cameraDeviceId} limit={cameraLimit} />}

      {native ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The microphone test belongs to the web view. With the app's audio engine
          on, the microphone is only captured for a call, so the call bar's
          Details panel is where its level reads.
        </p>
      ) : (
        <MicMeter deviceId={prefs.micDeviceId} onDevicesNamed={() => void listAudioDevices().then(setDevices)} />
      )}
    </div>
  );
}

/**
 * The camera picker, its tier, and a live preview.
 *
 * The preview is its own `getUserMedia`, released on unmount and on stop --
 * deliberately not the call's track, because this is answered *before* a
 * call and because holding a camera open in Settings is exactly the kind of
 * light nobody wants left on. Cameras come from the browser's list even
 * where the app's audio engine is on: video publishes through the web view
 * in v1 (docs/prompts/video-execution-handoff.md §0).
 */
function CameraSection({
  tier,
  deviceId,
  limit,
}: {
  tier: VideoQualityTier;
  deviceId: string | null;
  limit: { maxHeight: number; maxFps: number };
}) {
  const [cameras, setCameras] = useState<VideoDevice[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const element = useRef<HTMLVideoElement | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void listVideoDevices().then((list) => {
        if (!cancelled) setCameras(list);
      });
    };
    load();
    const off = onDeviceChange(load);
    return () => {
      cancelled = true;
      off();
      stopRef.current?.();
    };
  }, []);

  const preview = async (): Promise<void> => {
    stopRef.current?.();
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      // The first granted prompt unlocks the labels; re-read the list.
      void listVideoDevices().then(setCameras);
      if (element.current) element.current.srcObject = stream;
      setPreviewing(true);
      stopRef.current = () => {
        for (const track of stream.getTracks()) track.stop();
        if (element.current) element.current.srcObject = null;
        setPreviewing(false);
        stopRef.current = null;
      };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera access was refused. Allow it in the browser's site settings."
          : "The camera could not be started.",
      );
    }
  };

  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
        Camera
        <Select
          value={deviceId ?? ""}
          onChange={(e) => saveVoicePrefs({ cameraDeviceId: e.target.value || null })}
        >
          <option value="">Default</option>
          {cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label}
            </option>
          ))}
        </Select>
      </label>

      <label className="grid gap-1 text-sm text-neutral-700 dark:text-neutral-200">
        Video quality
        <Select
          value={tier}
          onChange={(e) => saveVoicePrefs({ videoQuality: e.target.value as VideoQualityTier })}
        >
          {(["standard", "auto", "hd"] as VideoQualityTier[]).map((value) => (
            <option key={value} value={value}>
              {VIDEO_QUALITY_LABELS[value]}
            </option>
          ))}
        </Select>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          Calls on this account allow up to {limit.maxHeight}p, and this setting
          can only ask for less. Applies to the next call you join.
        </span>
      </label>

      <div className="flex items-start gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (previewing ? stopRef.current?.() : void preview())}
        >
          {previewing ? "Stop preview" : "Preview camera"}
        </Button>
        <video
          ref={element}
          muted
          playsInline
          autoPlay
          // Mirrored, like every self-view: an unmirrored preview of your
          // own face reads as somebody else's.
          className={`aspect-video w-40 rounded bg-neutral-900 object-cover scale-x-[-1] ${
            previewing ? "" : "hidden"
          }`}
        />
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
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
