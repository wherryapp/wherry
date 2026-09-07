// The spike page inside the Tauri window: relays driver commands to the
// Rust side (src-tauri/src/spike.rs) and Rust events back to the driver.
// Throwaway, with the rest of client/spike/.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const DRIVER = "http://localhost:5199";
const out = document.getElementById("log");

function say(line) {
  out.textContent = `${new Date().toISOString().slice(11, 23)} ${line}\n${out.textContent}`.slice(0, 40_000);
}

function post(path, body) {
  return fetch(`${DRIVER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await listen("spike", (event) => {
  say(`event ${JSON.stringify(event.payload)}`);
  void post("/event", event.payload);
});
say("listening for spike events; polling the driver");
window.spike = { invoke };
void post("/event", { kind: "page", note: "loaded", ua: navigator.userAgent });
window.addEventListener("error", (e) => void post("/event", { kind: "page", note: `error ${e.message}` }));
window.addEventListener("unhandledrejection", (e) =>
  void post("/event", { kind: "page", note: `rejection ${String(e.reason)}` }),
);

for (;;) {
  let job;
  try {
    const res = await fetch(`${DRIVER}/next`, { cache: "no-store" });
    if (res.status !== 200) continue;
    job = await res.json();
  } catch (error) {
    void post("/event", { kind: "page", note: `poll failed ${String(error)}` });
    await sleep(1000);
    continue;
  }
  say(`run ${job.cmd} ${JSON.stringify(job.args)}`);
  try {
    const value = await invoke(job.cmd, job.args);
    say(`ok ${JSON.stringify(value).slice(0, 800)}`);
    await post("/result", { id: job.id, ok: true, value });
  } catch (error) {
    say(`error ${String(error)}`);
    await post("/result", { id: job.id, ok: false, error: String(error) });
  }
}
