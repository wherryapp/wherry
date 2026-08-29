import { useCallback, useEffect, useState } from "react";
import { logout } from "./api/client";
import { clearSession, loadSession, type StoredSession } from "./api/session";
import { requestPersistentStorage, store } from "./store";
import { sync } from "./sync/engine";
import { broadcast, subscribeToBroadcasts } from "./sync/leader";
import { Chat } from "./ui/Chat";
import { Login } from "./ui/Login";

export default function App() {
  // Read synchronously so the first render already knows which screen to show.
  // This is why the session lives in localStorage rather than IndexedDB --
  // an async read would mean a flash of the login form on every reload.
  const [session, setSession] = useState<StoredSession | null>(() =>
    loadSession(),
  );

  const signOutLocally = useCallback(async () => {
    sync.stop();
    clearSession();
    // Local history is per account: the next person to sign in on this browser
    // must not see it. Note this does *not* clear the device id, which lives
    // in localStorage and outlives the session on purpose.
    await store.clear();
    setSession(null);
  }, []);

  // Start and stop the engine with the session.
  useEffect(() => {
    if (!session) return;

    void requestPersistentStorage();

    sync.start({
      // The token is dead. Stopping is not enough -- the UI has to fall back
      // to the login screen, or it would sit on a timeline that can no longer
      // be updated.
      onUnauthorized: () => {
        void signOutLocally();
      },
    });

    return () => sync.stop();
  }, [session, signOutLocally]);

  // A sign-out in one tab has to reach the others, or they keep rendering a
  // dead session's history.
  useEffect(() => {
    return subscribeToBroadcasts((message) => {
      if (message.type === "signed-out") setSession(null);
    });
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Best effort. The session is revoked server-side if this succeeds, but
      // a failed request must not trap the user in a signed-in UI.
      await logout();
    } catch {
      // Ignored on purpose.
    }
    broadcast({ type: "signed-out" });
    await signOutLocally();
  }, [signOutLocally]);

  if (!session) return <Login onSignedIn={setSession} />;
  return <Chat session={session} onSignOut={signOut} />;
}
