// The stage-0 driver: a queue between the terminal and the Tauri window.
//
// Nothing can click inside the shell's webview from here, so the spike
// page (native.js) long-polls this server for commands, invokes them on
// the Rust side, and posts the results and every Rust event back. The
// terminal then drives the whole probe with curl against /run.
//
//   node client/spike/driver.mjs
//   curl -sG localhost:5199/run --data-urlencode cmd=spike_info
//   curl -sG localhost:5199/run --data-urlencode cmd=spike_devices
//   curl -s 'localhost:5199/events?kind=rms'
//
// Throwaway, with the rest of client/spike/.

import http from "node:http";

const PORT = 5199;
const queue = [];
const waiters = [];
const results = new Map();
const events = [];
let nextId = 1;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (line) => console.log(`[${stamp()}] ${line}`);

function json(res, code, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(text);
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function dispatch() {
  while (queue.length > 0 && waiters.length > 0) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    json(waiter.res, 200, queue.shift());
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return json(res, 204);

    if (url.pathname === "/next") {
      log(`poll from ${req.headers.origin ?? req.headers["user-agent"]?.slice(0, 40) ?? "?"}`);
      const timer = setTimeout(() => {
        const index = waiters.findIndex((w) => w.res === res);
        if (index >= 0) waiters.splice(index, 1);
        log("poll timed out (204)");
        json(res, 204);
      }, 20_000);
      waiters.push({ res, timer });
      req.on("close", () => {
        const index = waiters.findIndex((w) => w.res === res);
        if (index >= 0) {
          clearTimeout(timer);
          waiters.splice(index, 1);
          log("poll closed by client");
        }
      });
      dispatch();
      return;
    }

    if (url.pathname === "/result" && req.method === "POST") {
      const body = await readBody(req);
      results.set(body.id, body);
      log(
        `result #${body.id} ${body.ok ? "ok" : "ERROR"} ${JSON.stringify(body.ok ? body.value : body.error).slice(0, 600)}`,
      );
      return json(res, 200, {});
    }

    if (url.pathname === "/event" && req.method === "POST") {
      const body = await readBody(req);
      body.at = Date.now();
      events.push(body);
      log(`event ${JSON.stringify(body).slice(0, 400)}`);
      return json(res, 200, {});
    }

    if (url.pathname === "/run") {
      const cmd = url.searchParams.get("cmd");
      const args = JSON.parse(url.searchParams.get("args") || "{}");
      const wait = Number(url.searchParams.get("wait") || 30_000);
      const id = nextId++;
      queue.push({ id, cmd, args });
      log(`queue #${id} ${cmd} ${JSON.stringify(args).slice(0, 200)}`);
      dispatch();
      const deadline = Date.now() + wait;
      while (!results.has(id)) {
        if (Date.now() > deadline) return json(res, 504, { id, ok: false, error: "driver timeout" });
        await sleep(50);
      }
      return json(res, 200, results.get(id));
    }

    if (url.pathname === "/events") {
      const since = Number(url.searchParams.get("since") || 0);
      const kind = url.searchParams.get("kind");
      return json(
        res,
        200,
        events.slice(since).filter((event) => !kind || event.kind === kind),
      );
    }

    if (url.pathname === "/state") {
      return json(res, 200, {
        queued: queue.length,
        waiting: waiters.length,
        results: results.size,
        events: events.length,
      });
    }

    json(res, 404, { error: "unknown path" });
  })
  .listen(PORT, () => log(`driver listening on :${PORT}`));
