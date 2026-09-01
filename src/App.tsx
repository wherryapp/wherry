import { useCallback, useEffect, useState } from "react";
import { logout } from "./api/client";
import { clearSession, loadSession, type StoredSession } from "./api/session";
import { clearAccountKeypair, clearHistoryKeys } from "./crypto/db";
import { requestPersistentStorage, store } from "./store";
import { sync } from "./sync/engine";
import { broadcast, subscribeToBroadcasts } from "./sync/leader";
import { Chat } from "./ui/Chat";
import { Login } from "./ui/Login";
import { VerifyGate } from "./ui/VerifyGate";
import { VersionWall, useVersionFloor } from "./ui/VersionWall";
import {
  ResetPassword,
  VerifyEmail,
  routeFromLocation,
} from "./ui/EmailLanding";

export default function App() {
  // Read synchronously so the first render already knows which screen to show.
  // This is why the session lives in localStorage rather than IndexedDB --
  // an async read would mean a flash of the login form on every reload.
  const [session, setSession] = useState<StoredSession | null>(() =>
    loadSession(),
  );

  // Read once at startup, from the URL. There is no router: the app is one
  // screen with panels, and adding a routing library so that two emailed links
  // can be opened would be more machinery than the thing it serves. Caddy
  // already falls back to index.html for unknown paths, so both URLs load.
  const [emailRoute, setEmailRoute] = useState(routeFromLocation);

  // The version floor's hard stop -- checked here, above every other
  // screen, because a build the server no longer supports must not get to
  // sync, send, or even show a login form that would sign into an
  // incompatible API. Fail-safe by construction (see VersionWall.tsx), so
  // rendering the wall means the floor was actually read and exceeded.
  const floor = useVersionFloor();

  // An invite token is a bearer credential for a membership: taken out of
  // the URL immediately, so it survives in neither history nor whatever the
  // browser syncs. The state keeps it across the sign-in an invited
  // stranger usually still has ahead of them.
  useEffect(() => {
    if (emailRoute?.kind === "join") {
      window.history.replaceState(null, "", "/");
    }
  }, [emailRoute]);

  const signOutLocally = useCallback(async () => {
    sync.stop();
    clearSession();
    // Local history is per account: the next person to sign in on this browser
    // must not see it. Note this does *not* clear the device id, which lives
    // in localStorage and outlives the session on purpose.
    await store.clear();
    setSession(null);
  }, []);

  // Start and stop the engine with the session. Not until the address is
  // verified: almost every route the engine calls now requires one, so
  // starting it earlier would just be a poll loop generating 403s.
  useEffect(() => {
    if (!session || !session.emailVerified) return;
    // A build below the version floor must stop talking to the server --
    // that is the entire point of the wall. The engine is also what
    // *noticed* a floor raised mid-session, so this cleanup (not the wall)
    // is what actually quiets the client.
    if (floor.blocked) return;

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
  }, [session, signOutLocally, floor.blocked]);

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
    // Only an *explicit* sign-out forgets the account key. The 401 path above
    // keeps it, so a password reset can be repaired without the recovery code
    // -- see clearAccountKeypair in crypto/db.ts for the reasoning.
    await clearAccountKeypair();
    // History keys are account material too, and go the same way for the
    // same reason. Recoverable: GET /history-keys re-serves the wrapped set
    // to the next sign-in that unlocks the account key.
    await clearHistoryKeys();
    await signOutLocally();
  }, [signOutLocally]);

  if (floor.blocked) return <VersionWall minVersion={floor.minVersion} />;

  // Ahead of the session check on purpose: both of these are reached from a
  // link in an email and neither needs a session. Somebody confirming an
  // address on the phone they read mail on is usually not signed in there.
  if (emailRoute?.kind === "verify") {
    return (
      <VerifyEmail token={emailRoute.token} onDone={() => setEmailRoute(null)} />
    );
  }

  if (emailRoute?.kind === "reset") {
    return (
      <ResetPassword
        token={emailRoute.token}
        onDone={() => {
          // A reset signs out every device, this one included. Clearing the
          // local session is what stops the app dropping back into a
          // signed-in screen whose token the server has already revoked.
          void signOutLocally();
          setEmailRoute(null);
        }}
      />
    );
  }

  if (!session) return <Login onSignedIn={setSession} />;

  if (!session.emailVerified) {
    return (
      <VerifyGate session={session} onVerified={setSession} onSignOut={signOut} />
    );
  }

  return (
    <Chat
      session={session}
      onSignOut={signOut}
      inviteToken={emailRoute?.kind === "join" ? emailRoute.token : null}
      onInviteHandled={() => setEmailRoute(null)}
    />
  );
}
