// Microphones and speakers, as the browser will admit to -- or, when the
// desktop shell's own media engine is on (native-media.ts), as the audio
// device module enumerates them: real labels without a permission grant
// and ids that survive a replug, which is half of what the plan's §4
// wanted from the seam. Browser labels are empty until a getUserMedia
// permission has been granted once, so the picker says "Microphone 1"
// until then; `setSinkId` is what an output choice needs and Safari (and
// so iOS) does not have it, so the speaker picker hides itself there
// rather than offering a control that does nothing.
//
// The two id spaces do not overlap. A preference saved under one is
// checked against the live list before it is used (transport-rules.ts's
// `knownDeviceId`), so flipping the engine on or off falls back to the
// default device rather than failing a call.

import { nativeMediaSelected, nativeVideoAvailable } from "./native-media";

export type AudioDevice = { deviceId: string; label: string };

export type AudioDevices = { inputs: AudioDevice[]; outputs: AudioDevice[] };

/** A camera, in the same shape a microphone takes. */
export type VideoDevice = AudioDevice;

/** The shell's event when the device list changed (voice.rs polls the
 *  device module itself, since it raises no hot-plug event of its own). */
const NATIVE_DEVICES_EVENT = "voice-devices";

export function mediaSupported(): boolean {
  if (nativeMediaSelected()) return true;
  return (
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function supportsSpeakerSelection(): boolean {
  if (nativeMediaSelected()) return true;
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

async function listNativeDevices(): Promise<AudioDevices> {
  try {
    const core = await import("@tauri-apps/api/core");
    return await core.invoke<AudioDevices>("voice_devices");
  } catch {
    return { inputs: [], outputs: [] };
  }
}

export async function listAudioDevices(): Promise<AudioDevices> {
  if (nativeMediaSelected()) return listNativeDevices();
  if (!mediaSupported()) return { inputs: [], outputs: [] };
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { inputs: [], outputs: [] };
  }
  let inputs = 0;
  let outputs = 0;
  const named = (device: MediaDeviceInfo, fallback: string): AudioDevice => ({
    deviceId: device.deviceId,
    label: device.label || fallback,
  });
  return {
    inputs: devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => named(device, `Microphone ${(inputs += 1)}`)),
    outputs: supportsSpeakerSelection()
      ? devices
          .filter((device) => device.kind === "audiooutput")
          .map((device) => named(device, `Speaker ${(outputs += 1)}`))
      : [],
  };
}

/**
 * The cameras this browser will admit to.
 *
 * The shell's list where the native engine does video (macOS since
 * 2026-09-08, `voice_video_devices`): real labels, the same ids the native
 * publish takes, no permission needed. Everywhere else -- the web, the
 * phones, and a desktop shell whose probe answers `video: false` -- the
 * browser's, because that is the transport that will open the camera.
 *
 * Labels there are empty until a camera permission has been granted once,
 * the same as microphones, so the picker says "Camera 1" until then.
 */
export async function listVideoDevices(): Promise<VideoDevice[]> {
  if (nativeVideoAvailable() && nativeMediaSelected()) {
    // The shell lists its own cameras (voice/video.rs): real labels, no
    // permission needed, the same ids the native publish takes.
    try {
      const core = await import("@tauri-apps/api/core");
      return await core.invoke<VideoDevice[]>("voice_video_devices");
    } catch {
      return [];
    }
  }
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.enumerateDevices !== "function"
  ) {
    return [];
  }
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  let seen = 0;
  return devices
    .filter((device) => device.kind === "videoinput")
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${(seen += 1)}`,
    }));
}

/** Fires when a device is plugged or unplugged. Returns the unsubscribe. */
export function onDeviceChange(listener: () => void): () => void {
  if (nativeMediaSelected()) {
    // The shell watches the device module and says when the list moved;
    // no page timer, so this works while a hidden page's timers are
    // throttled too.
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(async (event) => {
      const off = await event.listen(NATIVE_DEVICES_EVENT, () => listener());
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }
  if (!mediaSupported()) return () => {};
  navigator.mediaDevices.addEventListener("devicechange", listener);
  return () => navigator.mediaDevices.removeEventListener("devicechange", listener);
}
