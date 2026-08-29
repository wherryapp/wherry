// A temporary on-screen readout of what the viewport is doing.
//
// Off unless the URL says `?debug=viewport`, so it costs nothing in normal use.
// It exists because the keyboard behaviour it is diagnosing cannot be
// reproduced anywhere except a real phone: a desktop browser honours
// `overflow: hidden`, which is the exact thing iOS ignores when it scrolls a
// focused input into view. Two guesses at the mechanism have been wrong, and
// the way to stop guessing is to read the numbers off the device.
//
// Delete this file once the keyboard behaves. It is a diagnostic, not a
// feature, and it should not outlive the question it answers.

type Sample = {
  ms: number;
  scrollY: number;
  vvHeight: number;
  vvOffsetTop: number;
  vvPageTop: number;
  rootTop: number;
  rootHeight: number;
  headerTop: number;
  docHeight: number;
};

const SAMPLE_MS = 1500;

function read(startedAt: number): Sample {
  const viewport = window.visualViewport;
  const root = document.getElementById("root");
  const rootBox = root?.getBoundingClientRect();
  const headerBox = document.querySelector("header")?.getBoundingClientRect();

  return {
    ms: Math.round(performance.now() - startedAt),
    scrollY: Math.round(window.scrollY),
    vvHeight: Math.round(viewport?.height ?? 0),
    vvOffsetTop: Math.round(viewport?.offsetTop ?? 0),
    vvPageTop: Math.round(viewport?.pageTop ?? 0),
    rootTop: Math.round(rootBox?.top ?? 0),
    rootHeight: Math.round(rootBox?.height ?? 0),
    headerTop: Math.round(headerBox?.top ?? 0),
    docHeight: Math.round(
      document.documentElement.getBoundingClientRect().height,
    ),
  };
}

function summarise(samples: readonly Sample[]): string {
  if (samples.length === 0) return "no samples";

  const range = (pick: (s: Sample) => number): string => {
    const values = samples.map(pick);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? `${min}` : `${min}..${max}`;
  };

  const last = samples[samples.length - 1] as Sample;

  // Ranges first, because the question is what *moved*, and a value that never
  // changed prints as a single number rather than a range.
  return [
    `frames ${samples.length} over ${last.ms}ms`,
    `scrollY     ${range((s) => s.scrollY)}`,
    `vv.height   ${range((s) => s.vvHeight)}`,
    `vv.offsetTop${range((s) => s.vvOffsetTop)}`,
    `vv.pageTop  ${range((s) => s.vvPageTop)}`,
    `root.top    ${range((s) => s.rootTop)}`,
    `root.height ${range((s) => s.rootHeight)}`,
    `header.top  ${range((s) => s.headerTop)}`,
    `doc.height  ${range((s) => s.docHeight)}`,
    `innerHeight ${window.innerHeight}`,
  ].join("\n");
}

/** Starts the readout when `?debug=viewport` is in the URL. */
export function startViewportDebug(): void {
  if (!new URLSearchParams(window.location.search).has("debug")) return;

  const panel = document.createElement("pre");
  panel.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "z-index:2147483647",
    "margin:0",
    "padding:4px 6px",
    "font:11px/1.35 ui-monospace,monospace",
    "color:#0f0",
    "background:rgba(0,0,0,.82)",
    "pointer-events:none",
    "white-space:pre",
  ].join(";");
  panel.textContent = "tap the message box";
  document.body.appendChild(panel);

  let samples: Sample[] = [];
  let startedAt = 0;
  let sampling = false;

  const tick = (): void => {
    samples.push(read(startedAt));
    panel.textContent = summarise(samples);

    if (performance.now() - startedAt < SAMPLE_MS) {
      requestAnimationFrame(tick);
    } else {
      sampling = false;
    }
  };

  // focusin, because the keyboard is a consequence of focus and this is the
  // earliest point at which anything can be recorded.
  window.addEventListener("focusin", () => {
    samples = [];
    startedAt = performance.now();
    if (!sampling) {
      sampling = true;
      requestAnimationFrame(tick);
    }
  });
}
