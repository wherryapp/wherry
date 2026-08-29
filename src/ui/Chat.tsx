import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { bytesToText, textToBytes } from "../api/base64";
import { ApiError, createConversation, lookupUser } from "../api/client";
import type { StoredSession } from "../api/session";
import { PROTOCOL_PLAINTEXT } from "../api/types";
import type { StoredConversation, StoredMessage } from "../store/types";
import { sync } from "../sync/engine";
import {
  useConversations,
  useLatestMessages,
  useSyncStatus,
  useTimeline,
  type TimelineItem,
} from "./hooks";
import {
  availability as pushAvailability,
  disable as disablePush,
  enable as enablePush,
  isSubscribed,
  type PushState,
} from "../sync/push";

// ---------------------------------------------------------------------------
// Rendering content
// ---------------------------------------------------------------------------

/**
 * Turns a stored payload into text, or null if this build cannot read it.
 *
 * This is CLAUDE.md rule 3 made visible. Version 1 payloads are plaintext;
 * version 2 will be ciphertext, and a client that assumed 1 would render
 * ciphertext as mojibake the day that changed. Old and new messages sit side
 * by side in storage forever, so the check is per message rather than a
 * per-account flag.
 */
function messageText(message: StoredMessage): string | null {
  if (message.protocolVersion !== PROTOCOL_PLAINTEXT) return null;
  try {
    return bytesToText(message.payload);
  } catch {
    return null;
  }
}

function conversationTitle(
  conversation: StoredConversation,
  selfUserId: string,
): string {
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  if (others.length === 0) return "You";
  return others.map((m) => m.displayName || m.username).join(", ");
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The banner for states worth interrupting the layout for.
 *
 * Deliberately says nothing about a routine sync. The loop polls every two
 * seconds, so a "Syncing…" banner would insert and remove itself from the
 * layout at the poll rate -- the content below it shifting down and back
 * roughly thirty times a minute. That is not a status indicator, it is a
 * flicker, and the information it conveys ("a poll happened") is worth
 * nothing to the person reading the conversation.
 *
 * What is worth showing is the three states that persist and that the user
 * can act on: history still loading, the server unreachable, the session
 * gone. Each of those is stable for seconds or longer, so the one-time shift
 * when it appears reads as a change rather than as jitter.
 *
 * Trouble is driven off `error` rather than `state === "offline"` on purpose.
 * While the connection is down the engine alternates between backing off and
 * retrying, so keying on the state would hide the banner for the duration of
 * every attempt -- the same flicker, just rarer and more confusing. The error
 * is set on failure and cleared only by a success, which is exactly the
 * condition worth rendering.
 */
function StatusLine() {
  const status = useSyncStatus();

  const label =
    status.state === "unauthorized"
      ? "Session expired"
      : status.state === "hydrating"
        ? "Loading history…"
        : status.error !== null
          ? status.error
          : null;

  if (!label) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting a conversation
// ---------------------------------------------------------------------------

/**
 * Username in, conversation out.
 *
 * Two calls, because `POST /conversations` takes ids and a person types names.
 * `GET /users/lookup` is the only thing that bridges them -- without it the
 * only ids a client ever holds are the ones already in its conversations,
 * which makes starting the first one impossible.
 */
function NewConversation({
  session,
  onOpened,
}: {
  session: StoredSession;
  onOpened: (conversationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const user = await lookupUser(username.trim());

      if (user.id === session.user.id) {
        setError("You cannot start a conversation with yourself.");
        return;
      }

      // Find-or-create: if this pair already has a conversation this returns
      // it rather than splitting the history in two.
      const conversation = await createConversation({
        kind: "direct",
        memberUserIds: [user.id],
      });

      // The list is refreshed on a timer, so nudge it rather than waiting.
      sync.invalidateConversations();
      onOpened(conversation.id);

      setUsername("");
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with that username."
          : caught instanceof ApiError
            ? caught.message
            : "Cannot reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
      >
        New conversation
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="username"
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      />
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || username.trim().length === 0}
          className="flex-1 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "…" : "Start"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-500"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * The notification toggle, and an explanation when it cannot be one.
 *
 * Never asks on load. A permission prompt that arrives before somebody knows
 * what the app is gets refused, and a refusal on iOS is permanent from the
 * page's side -- only the browser's own settings can undo it. So this is a
 * button, and the prompt happens when it is pressed.
 */
function NotificationSetting() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const available = pushAvailability();
      if (available.state !== "ready") {
        if (!cancelled) setState(available.state);
        return;
      }
      const on = await isSubscribed();
      if (!cancelled) setState(on ? "on" : "ready");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to say on a browser that could never do this.
  if (state === null || state === "unsupported") return null;

  if (state === "needs-install") {
    return (
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        Add this to your home screen to get notifications.
      </p>
    );
  }

  if (state === "blocked") {
    return (
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        Notifications are blocked in your browser settings.
      </p>
    );
  }

  if (state === "server-disabled") {
    return (
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        Notifications are not set up on this server.
      </p>
    );
  }

  const on = state === "on";

  return (
    <button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void (on ? disablePush() : enablePush())
          .then(setState)
          .catch(() => setState(on ? "on" : "ready"))
          .finally(() => setBusy(false));
      }}
      className="mt-2 text-xs text-neutral-500 underline-offset-2 hover:underline disabled:opacity-50 dark:text-neutral-400"
    >
      {busy ? "…" : on ? "Notifications on" : "Turn on notifications"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

// Tailwind's `md` breakpoint, expressed in JS because two things depend on the
// answer that CSS cannot express: which pane is *rendered*, and whether a
// conversation is auto-selected on load. Auto-selecting on a phone would drop
// somebody into a thread when they were expecting the list they last saw.
//
// Keep this number in step with the `md:` classes below. Tailwind's default
// md is 768px; there is no config file to read it from, by choice.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);

  // Resize as well as the media query, which looks redundant and is not. The
  // change event does not fire in every environment that can alter a viewport
  // -- an emulated one caught this during testing, where the query read as
  // matching while the layout was still in its phone shape. Re-reading on
  // resize means the value cannot disagree with what `matchMedia` says now.
  window.addEventListener("resize", onChange);

  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function useIsDesktop(): boolean {
  // useSyncExternalStore rather than state-plus-effect: the value is read
  // fresh on every notification, so there is no copy to fall out of step, and
  // no first render that shows the wrong layout before an effect corrects it.
  return useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(DESKTOP_QUERY).matches,
  );
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function ConversationList({
  session,
  selected,
  onSelect,
}: {
  session: StoredSession;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { conversations } = useConversations();
  const latest = useLatestMessages(conversations);

  return (
    <aside className="flex w-full shrink-0 flex-col bg-white md:w-72 md:border-r md:border-neutral-200 dark:bg-neutral-900 dark:md:border-neutral-800">
      <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
        <NewConversation session={session} onOpened={onSelect} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 && (
          <p className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
            No conversations yet.
          </p>
        )}

        {conversations.map((conversation) => {
          const preview = latest.get(conversation.id);
          const text = preview ? messageText(preview) : null;
          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className={`block w-full border-b border-neutral-100 px-4 py-3 text-left dark:border-neutral-800 ${
                selected === conversation.id
                  ? "bg-neutral-100 dark:bg-neutral-800"
                  : "hover:bg-neutral-50 dark:hover:bg-neutral-850"
              }`}
            >
              <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {conversationTitle(conversation, session.user.id)}
              </span>
              <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
                {preview
                  ? (text ?? "Encrypted message")
                  : "No messages yet"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <div className="truncate">
          Signed in as{" "}
          <span className="font-medium text-neutral-700 dark:text-neutral-200">
            {session.user.username}
          </span>
        </div>
        <div className="truncate">{session.device.displayName}</div>
        <NotificationSetting />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Bubble({
  mine,
  text,
  meta,
  muted,
}: {
  mine: boolean;
  text: string | null;
  meta: string;
  muted?: boolean;
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 md:max-w-[70%] ${
          mine
            ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
            : "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        } ${muted ? "opacity-60" : ""}`}
      >
        {text === null ? (
          <span className="text-sm italic opacity-70">
            Encrypted message — this version cannot display it
          </span>
        ) : (
          <span className="whitespace-pre-wrap break-words text-sm">{text}</span>
        )}
        <span className="mt-1 block text-[10px] opacity-60">{meta}</span>
      </div>
    </div>
  );
}

function Timeline({
  conversationId,
  session,
}: {
  conversationId: string;
  session: StoredSession;
}) {
  const { items, hasMore, loadOlder } = useTimeline(conversationId);
  const bottom = useRef<HTMLDivElement>(null);
  const count = items.length;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, conversationId]);

  // The keyboard opening makes this pane shorter without moving what is
  // scrolled, so the newest message ends up hidden behind the composer at the
  // exact moment somebody is about to reply to it. Re-pin on every visual
  // viewport resize, which is the keyboard appearing, disappearing, or the
  // device being rotated.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const pin = (): void => {
      bottom.current?.scrollIntoView({ block: "end" });
    };

    viewport.addEventListener("resize", pin);
    return () => viewport.removeEventListener("resize", pin);
  }, []);

  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-4">
      {hasMore && (
        <button
          onClick={loadOlder}
          className="mx-auto block rounded-md px-3 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Load older messages
        </button>
      )}

      {items.map((item: TimelineItem) =>
        item.kind === "sent" ? (
          <Bubble
            key={item.message.messageId}
            mine={item.message.senderUserId === session.user.id}
            text={messageText(item.message)}
            meta={time(item.message.sentAt)}
          />
        ) : (
          <Bubble
            key={item.entry.clientMessageId}
            mine
            muted
            text={bytesToText(item.entry.payload)}
            meta={
              item.entry.failedPermanently
                ? `Failed — ${item.entry.lastError ?? "not sent"}`
                : "Sending…"
            }
          />
        ),
      )}

      <div ref={bottom} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    // Cleared before the await, so typing the next message is never blocked on
    // the network. The message is already durable in the outbox by the time
    // this resolves, and the engine owns getting it delivered.
    setText("");
    await sync.enqueue(conversationId, textToBytes(trimmed));
  }

  return (
    <form
      onSubmit={submit}
      className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message"
        className="flex-1 rounded-full border border-neutral-300 bg-white px-4 py-2 text-base outline-none focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <button
        type="submit"
        disabled={text.trim().length === 0}
        className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Send
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Chat({
  session,
  onSignOut,
}: {
  session: StoredSession;
  onSignOut: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const { conversations } = useConversations();
  const isDesktop = useIsDesktop();

  // Open the newest conversation on first load, so the app does not start on
  // an empty panel when there is something to show.
  //
  // Desktop only. On a phone the two panes are two screens, and pre-selecting
  // means opening the app *inside* a thread with a back button as the only
  // clue that a list exists.
  useEffect(() => {
    if (!isDesktop) return;
    if (selected === null && conversations[0]) setSelected(conversations[0].id);
  }, [conversations, selected, isDesktop]);

  const current = conversations.find((c) => c.id === selected);

  // Nothing resets the selection any more, on purpose.
  //
  // It used to, to rescue a phone from a thread pane with no way out. That was
  // treating the symptom: the pane is now driven by the selected *id*, which
  // is all the timeline and composer ever needed, so it renders -- with its
  // back button -- whether or not the metadata has arrived. `current` is only
  // consulted for the title.
  //
  // Which matters most in the case that produced the bug: starting a new
  // conversation selects an id the list has not been refreshed with yet, and
  // on a brand new account the list is empty, so the old guard
  // (`conversations.length > 0`) declined to rescue exactly the person who
  // most needed rescuing.

  // One pane at a time below md, both above it. Rendered rather than hidden:
  // the list and the thread each hold a subscription per conversation, and
  // there is no reason to run the one nobody can see.
  const showList = isDesktop || selected === null;
  const showThread = isDesktop || selected !== null;

  return (
    <div className="flex h-full flex-col bg-neutral-50 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          messenger
        </span>
        <button
          onClick={onSignOut}
          className="text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          Sign out
        </button>
      </header>

      <StatusLine />

      <div className="flex min-h-0 flex-1">
        {showList && (
          <ConversationList
            session={session}
            selected={selected}
            onSelect={setSelected}
          />
        )}

        {showThread && (
          <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-900">
            {selected !== null ? (
              <>
                <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
                  {!isDesktop && (
                    <button
                      onClick={() => setSelected(null)}
                      aria-label="Back to conversations"
                      className="-ml-2 rounded px-2 py-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      ←
                    </button>
                  )}
                  <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {current
                      ? conversationTitle(current, session.user.id)
                      : "Conversation"}
                  </span>
                </div>
                <Timeline conversationId={selected} session={session} />
                <Composer conversationId={selected} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
                Pick a conversation, or start a new one.
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
