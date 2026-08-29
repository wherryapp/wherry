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

// The payload never contains the message, and cannot.
//
// The server composes this notification, and the server cannot read message
// content -- rule 1 in CLAUDE.md, and not merely a policy: once payloads are
// ciphertext there is nothing to put in a preview even if the rule were
// dropped. So the notification says something arrived, and the app shows what
// it was once it is open and has decrypted it locally.
self.addEventListener("push", (event) => {
  let title = "New message";
  let body = "Open messenger to read it.";

  // A push with no data at all is valid and is what a "wake up and check"
  // notification looks like. Anything that does arrive is untrusted input from
  // the wire, so it is parsed defensively rather than assumed.
  if (event.data) {
    try {
      const data = event.data.json();
      if (typeof data.title === "string") title = data.title;
      if (typeof data.body === "string") body = data.body;
    } catch {
      // Not JSON. The defaults above are already the right answer.
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One notification that replaces itself, rather than a stack of
      // identical "new message" rows for a conversation somebody is about to
      // open anyway.
      tag: "messenger-message",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

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
