// Call sounds, synthesised. No audio assets: a ring, a ringback, and the
// join/leave/mute blips are a few oscillators, which means no CSP change
// in the shells, no download, and one place to tune. Everything here is
// best effort -- an AudioContext the browser refuses to start (no user
// gesture yet) fails silently, and a ring that could not sound still shows
// its overlay.

let context: AudioContext | null = null;
let activeLoops = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function ctx(): AudioContext | null {
  try {
    if (!context) context = new AudioContext();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

/**
 * Suspend once the last scheduled sound has ended and no loop is running.
 * A running AudioContext keeps the platform's audio unit and its render
 * thread alive with nothing to play -- on a phone in a call, where WebRTC
 * already owns the hardware, that is heat for nothing (the maintainer's
 * first device report). Idle therefore means suspended; ctx() resumes on
 * the next sound. Believed, not measured on a phone.
 */
function idleAfter(seconds: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeLoops === 0 && context?.state === "running") {
      void context.suspend().catch(() => {});
    }
  }, seconds * 1000 + 250);
}

/** A gentle two-tone burst, `seconds` long, at `gain`. */
function tone(
  audio: AudioContext,
  frequencies: readonly number[],
  seconds: number,
  gain: number,
  at: number,
): void {
  for (const frequency of frequencies) {
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(gain, at + 0.02);
    amp.gain.setValueAtTime(gain, at + seconds - 0.03);
    amp.gain.linearRampToValueAtTime(0, at + seconds);
    osc.connect(amp).connect(audio.destination);
    osc.start(at);
    osc.stop(at + seconds);
  }
}

type Loop = { stop: () => void };

/** A repeating pattern until stopped. `period` is the cycle length. */
function loop(pattern: (audio: AudioContext, at: number) => void, period: number): Loop | null {
  const audio = ctx();
  if (!audio) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  activeLoops += 1;
  const cycle = (): void => {
    if (stopped) return;
    pattern(audio, audio.currentTime);
    timer = setTimeout(cycle, period * 1000);
  };
  cycle();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      activeLoops -= 1;
      if (timer) clearTimeout(timer);
      // The cycle's tones may still be sounding: the longest is 2 s.
      idleAfter(2);
    },
  };
}

/** The caller's side: the classic 440+480 Hz ringback, 2 s on, 4 s off. */
export function startRingback(): Loop | null {
  return loop((audio, at) => tone(audio, [440, 480], 2, 0.08, at), 6);
}

/** The callee's side: two short pulses, then a pause. Quieter than a phone. */
export function startRing(): Loop | null {
  return loop((audio, at) => {
    tone(audio, [660, 880], 0.5, 0.12, at);
    tone(audio, [660, 880], 0.5, 0.12, at + 0.7);
  }, 3);
}

export function blip(kind: "join" | "leave" | "mute" | "unmute"): void {
  playBlip(kind);
  idleAfter(BLIP_SECONDS);
}

/** The longest blip below ends 0.21 s after it starts. */
const BLIP_SECONDS = 0.25;

function playBlip(kind: "join" | "leave" | "mute" | "unmute"): void {
  const audio = ctx();
  if (!audio) return;
  const at = audio.currentTime;
  switch (kind) {
    case "join":
      tone(audio, [523], 0.09, 0.1, at);
      tone(audio, [784], 0.12, 0.1, at + 0.09);
      return;
    case "leave":
      tone(audio, [784], 0.09, 0.1, at);
      tone(audio, [523], 0.12, 0.1, at + 0.09);
      return;
    case "mute":
      tone(audio, [392], 0.08, 0.08, at);
      return;
    case "unmute":
      tone(audio, [587], 0.08, 0.08, at);
      return;
  }
}
