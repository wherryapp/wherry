// Microphones and speakers, as the browser will admit to. Labels are empty
// until a getUserMedia permission has been granted once, so the picker
// says "Microphone 1" until then; `setSinkId` is what an output choice
// needs and Safari (and so iOS) does not have it, so the speaker picker
// hides itself there rather than offering a control that does nothing.

export type AudioDevice = { deviceId: string; label: string };

export type AudioDevices = { inputs: AudioDevice[]; outputs: AudioDevice[] };

export function mediaSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function supportsSpeakerSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

export async function listAudioDevices(): Promise<AudioDevices> {
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

/** Fires when a device is plugged or unplugged. Returns the unsubscribe. */
export function onDeviceChange(listener: () => void): () => void {
  if (!mediaSupported()) return () => {};
  navigator.mediaDevices.addEventListener("devicechange", listener);
  return () => navigator.mediaDevices.removeEventListener("devicechange", listener);
}
