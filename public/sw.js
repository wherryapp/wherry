// The service worker.
//
// It exists for one reason: push notifications cannot be delivered without
// one, and on iOS they cannot be delivered at all unless the site has been
// added to the home screen. Everything here serves that, and nothing else.
//
// ---------------------------------------------------------------------------
// It deliberately does not cache
// ---------------------------------------------------------------------------
//
// No `fetch` handler, no precache, no offline shell. That is the whole point
// of the omission, not an unfinished part.
//
// A cached app shell is a client frozen at whatever version installed it,
// talking to an API that has moved on -- and the failure is invisible, because
// the page loads perfectly and is simply old. The deploy pipeline already
// solves freshness properly: Vite fingerprints every asset, Caddy caches those
// forever and serves everything else `no-cache`, so a reload gets the new
// build and nothing else has to be kept in step.
//
// Offline reading is a real feature and it already has a real implementation:
// the client renders timelines from IndexedDB, so history is available without
// the network once the page is open. What is missing is the *page* loading
// offline, and that is worth adding deliberately, with a versioned cache and a
// story for invalidation -- not as a side effect of needing push.

self.addEventListener("install", () => {
  // Take over immediately. The alternative is a worker that only becomes
  // active once every tab is closed, which for an app people leave open is
  // indistinguishable from the update never arriving.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

// The payload names the sender and never contains the message.
//
// Who sent it is metadata the server has always held in the clear; the body is
// content it cannot read, now or ever -- once payloads are ciphertext there is
// nothing to preview even if rule 1 were dropped. So a notification says who,
// and the app shows what once it is open and has decrypted it locally.
self.addEventListener("push", (event) => {
  let title = "New message";
  let body = "Open messenger to read it.";
  let tag = "messenger-message";
  // Voice (docs/prompts/voice-plan.md §6.2): a ring is the one notification
  // that must interrupt -- it stays up until acted on, re-alerts, and
  // carries Answer/Decline. A missed call is an ordinary notification
  // that replaces the ring's row (same tag, set by the server).
  let kind = "message";

  // A push with no data at all is valid and is what a "wake up and check"
  // notification looks like. Anything that does arrive is untrusted input from
  // the wire, so it is parsed defensively rather than assumed.
  if (event.data) {
    try {
      const data = event.data.json();
      if (typeof data.title === "string") title = data.title;
      if (typeof data.body === "string") body = data.body;
      if (typeof data.tag === "string") tag = data.tag;
      if (data.kind === "call" || data.kind === "missed_call") kind = data.kind;
    } catch {
      // Not JSON. The defaults above are already the right answer.
    }
  }

  event.waitUntil(
    (async () => {
      // A focused window means the person is inside the app right now, and
      // the app is its own notification surface -- the timeline, the sidebar
      // badge, the tab title. An OS toast on top of that is noise, and worse
      // when it is for the very conversation being read. Decided 2026-08-31;
      // the desktop shell's notifications follow the same rule.
      //
      // Chrome exempts exactly this case from the userVisibleOnly quota.
      // Safari does not document an exemption and can revoke push after
      // repeated silent handles -- accepted: on iOS a focused client means
      // the installed app is foreground, where a toast is at its most
      // pointless, and re-enabling push is one Settings toggle if it ever
      // bites.
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // A ring is the exception to the focused-window rule: the app shows
      // its own overlay when focused, but a ring's push and its socket frame
      // race, and a notification that also rings the phone is worth one
      // duplicate. Everything else keeps the rule.
      if (kind !== "call" && clientList.some((client) => client.focused)) return;

      if (kind === "call") {
        await self.registration.showNotification(title, {
          body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag,
          renotify: true,
          requireInteraction: true,
          vibrate: [300, 150, 300, 150, 300],
          // Answer opens the app, where the ring overlay is already showing
          // if the call is still ringing. Decline only closes this
          // notification: the worker holds no session token, so the
          // decline itself is not posted, and the ring times out.
          actions: [
            { action: "answer", title: "Answer" },
            { action: "decline", title: "Decline" },
          ],
        });
        return;
      }

      await self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        // Grouped per conversation by the server, so a second message from
        // the same person replaces the first rather than stacking, while two
        // different people produce two separate rows. A single fixed tag
        // would have let one chatty conversation hide another entirely.
        tag,
        // The first message alerts; replacements update the row quietly.
        // `true` here made every message in a busy conversation buzz again,
        // which is a stream of interruptions carrying one fact.
        renotify: false,
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // A declined ring: nothing to open. See the push handler above.
  if (event.action === "decline") return;

  // Focus an open tab if there is one, rather than opening a second copy of an
  // app that is already running.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow("/");
      }),
  );
});
