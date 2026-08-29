import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Attachment } from "./Attachment";
import { Settings } from "./Settings";
import {
  decodeContent,
  encodeContent,
  type AttachmentRef,
  type MessageContent,
} from "../api/payload";
import { prepareForUpload } from "./media";
import {
  ApiError,
  createConversation,
  fetchAttachmentUsage,
  lookupUser,
  markConversationRead,
  uploadAttachment,
} from "../api/client";
import { store } from "../store";
import type { StoredSession } from "../api/session";
import { PROTOCOL_PLAINTEXT } from "../api/types";
import type { StoredConversation, StoredMessage } from "../store/types";
import { sync } from "../sync/engine";
import {
  useConversations,
  useLatestMessages,
  useSyncStatus,
  useTimeline,
  useUnread,
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
/**
 * What to render for a message, or null when it cannot be rendered at all.
 *
 * Null is kept distinct from empty content on purpose: a version 2 payload is
 * ciphertext this build has no key for, which is a different thing to say than
 * a message with no text, and the two look identical if they share a return
 * value.
 */
function messageContent(message: StoredMessage): MessageContent | null {
  if (message.protocolVersion !== PROTOCOL_PLAINTEXT) return null;
  return decodeContent(message.payload);
}

function conversationTitle(
  conversation: StoredConversation,
  selfUserId: string,
): string {
  const others = conversation.members.filter((m) => m.userId !== selfUserId);
  if (others.length === 0) return "You";
  return others.map((m) => m.displayName || m.username).join(", ");
}

/** A member's display name, for attribution in groups. */
function memberName(conversation: StoredConversation, userId: string): string {
  const member = conversation.members.find((m) => m.userId === userId);
  return member ? member.displayName || member.username : "Someone";
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
      // Comma or space separated, so a group is typed the same way a single
      // name is rather than behind a mode switch.
      const names = [
        ...new Set(
          username
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];

      if (names.length === 0) return;

      const found = await Promise.all(names.map((name) => lookupUser(name)));

      if (found.some((user) => user.id === session.user.id)) {
        setError("You are in every conversation you start; leave yourself out.");
        return;
      }

      // Two people is a direct conversation and is find-or-create, so naming
      // somebody you already talk to reopens that thread rather than splitting
      // the history in two. Three or more is a group, and groups always
      // create: two groups with the same people are legitimately different
      // groups, which is why the server does not deduplicate them.
      const conversation = await createConversation({
        kind: found.length === 1 ? "direct" : "group",
        memberUserIds: found.map((user) => user.id),
      });

      // The list is refreshed on a timer, so nudge it rather than waiting.
      sync.invalidateConversations();
      onOpened(conversation.id);

      setUsername("");
      setOpen(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with one of those usernames."
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
        placeholder="username, or several for a group"
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

/**
 * Marks a conversation read while it is on screen.
 *
 * Two conditions, both necessary. The conversation has to be open, and the
 * page has to be *visible* -- a thread left open on a backgrounded tab is not
 * being read, and marking it would clear a badge for messages nobody saw, on
 * every device at once.
 *
 * Fires on the newest message this device holds, whenever that changes. The
 * server only moves the marker forward, so re-sending the same id is a no-op
 * and there is no need to track whether this call would be one.
 */
function useMarkRead(conversationId: string | null, selfUserId: string): void {
  const { items } = useTimeline(conversationId);

  // The newest *stored* message. Outbox entries are excluded: they have no
  // server id yet, and marking your own unsent message read means nothing.
  let newest: string | null = null;
  for (const item of items) {
    if (item.kind === "sent") newest = item.message.messageId;
  }

  useEffect(() => {
    if (!conversationId || !newest) return;

    let cancelled = false;

    const mark = (): void => {
      // A thread open on a backgrounded tab is not being read, and marking it
      // would clear the badge on every device for messages nobody saw.
      if (cancelled || document.visibilityState !== "visible") return;

      void markConversationRead(conversationId, newest)
        .then(async () => {
          if (cancelled) return;
          // Locally too, so the badge clears now rather than whenever the next
          // conversation refresh brings the marker back.
          await store.mergeReadMarker(
            conversationId,
            selfUserId,
            newest,
            new Date().toISOString(),
          );
          sync.invalidateConversations();
        })
        .catch(() => {
          // Not worth surfacing. The marker is a convenience, the messages
          // are already delivered, and opening this again will retry.
        });
    };

    mark();

    // Coming back to a tab that already had the conversation open has to mark
    // it too. Without this the effect's dependencies have not changed, so
    // nothing would run again until the next message arrived -- leaving a
    // badge on a conversation being looked at.
    document.addEventListener("visibilitychange", mark);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", mark);
    };
  }, [conversationId, newest, selfUserId]);
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
  const unread = useUnread(conversations, session.user.id);

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
          const previewContent = preview ? messageContent(preview) : null;
          // A photo with no caption still has to say something in the list.
          const text = previewContent
            ? previewContent.text ||
              (previewContent.attachments.length > 0 ? "Photo" : "")
            : null;
          const count = unread.get(conversation.id) ?? 0;
          const isGroup = conversation.members.length > 2;

          // In a group the preview is ambiguous without a name -- "see you at
          // 6" from one of four people is half a message.
          const prefix =
            isGroup && preview && preview.senderUserId !== session.user.id
              ? `${memberName(conversation, preview.senderUserId)}: `
              : "";

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
              <span className="flex items-center gap-2">
                <span
                  className={`block flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100 ${
                    count > 0 ? "font-semibold" : "font-medium"
                  }`}
                >
                  {conversationTitle(conversation, session.user.id)}
                </span>
                {count > 0 && (
                  <span
                    aria-label={`${count} unread`}
                    className="shrink-0 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
                  >
                    {count > 98 ? "99+" : count}
                  </span>
                )}
              </span>
              <span
                className={`block truncate text-xs ${
                  count > 0
                    ? "text-neutral-700 dark:text-neutral-300"
                    : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                {preview
                  ? `${prefix}${text ?? "Encrypted message"}`
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
  content,
  meta,
  muted,
  sender,
}: {
  mine: boolean;
  /** Null when this build cannot display the payload at all. */
  content: MessageContent | null;
  meta: string;
  muted?: boolean;
  /**
   * Who sent it, on incoming messages in a group.
   *
   * Omitted in a 1:1, where left-versus-right already says it, and omitted on
   * your own messages for the same reason. In a group the sides carry no
   * information -- everybody else is on the left -- so without this a
   * three-way conversation is unreadable.
   */
  sender?: string | undefined;
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
        {sender && (
          <span className="mb-0.5 block text-[11px] font-medium opacity-70">
            {sender}
          </span>
        )}
        {content === null ? (
          <span className="text-sm italic opacity-70">
            Encrypted message — this version cannot display it
          </span>
        ) : (
          <>
            {content.attachments.length > 0 && (
              <span className="mb-1 block space-y-1">
                {content.attachments.map((attachment) => (
                  <Attachment key={attachment.id} attachment={attachment} />
                ))}
              </span>
            )}
            {content.text.length > 0 && (
              <span className="whitespace-pre-wrap break-words text-sm">
                {content.text}
              </span>
            )}
          </>
        )}
        <span className="mt-1 block text-[10px] opacity-60">{meta}</span>
      </div>
    </div>
  );
}

function Timeline({
  conversationId,
  session,
  conversation,
}: {
  conversationId: string;
  session: StoredSession;
  /** Undefined until the conversation list catches up; only names depend on it. */
  conversation: StoredConversation | undefined;
}) {
  const { items, hasMore, loadOlder } = useTimeline(conversationId);

  // Names by user id, so attribution is a lookup rather than a scan per
  // message. Only built for groups, since a 1:1 never shows them.
  const isGroup = (conversation?.members.length ?? 0) > 2;
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of conversation?.members ?? []) {
      map.set(member.userId, member.displayName || member.username);
    }
    return map;
  }, [conversation]);
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
            content={messageContent(item.message)}
            meta={time(item.message.sentAt)}
            sender={
              isGroup && item.message.senderUserId !== session.user.id
                ? (names.get(item.message.senderUserId) ?? "Someone")
                : undefined
            }
          />
        ) : (
          <Bubble
            key={item.entry.clientMessageId}
            mine
            muted
            content={decodeContent(item.entry.payload)}
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

type Pending = {
  file: File;
  /** A local preview, so a photo appears the moment it is chosen. */
  url: string;
};

function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Revoke preview URLs when they stop being used, or every photo somebody
  // picks and reconsiders is held in memory until the page is reloaded.
  useEffect(() => {
    return () => {
      for (const item of pending) URL.revokeObjectURL(item.url);
    };
  }, [pending]);

  function choose(event: FormEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];

    setPending((current) => [
      ...current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
    setError(null);

    // Cleared so picking the same file twice in a row still fires a change.
    input.value = "";
  }

  function remove(index: number): void {
    setPending((current) => {
      const item = current[index];
      if (item) URL.revokeObjectURL(item.url);
      return current.filter((_, i) => i !== index);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const trimmed = text.trim();
    if (trimmed.length === 0 && pending.length === 0) return;
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      // Uploaded before the message is queued, because the payload has to
      // carry the ids. That makes an attachment send fail *before* anything is
      // in the outbox, which is the right way round: a queued message
      // referring to an upload that never happened would retry forever and
      // never work.
      const limits = await fetchAttachmentUsage();
      const attachments: AttachmentRef[] = [];

      for (const item of pending) {
        const prepared = await prepareForUpload(item.file, limits.maxBytes);

        if ("kind" in prepared) {
          setError(prepared.message);
          return;
        }

        const uploaded = await uploadAttachment(conversationId, prepared.bytes);

        attachments.push({
          id: uploaded.id,
          mediaType: prepared.mediaType,
          byteSize: uploaded.byteSize,
          ...(prepared.width ? { width: prepared.width } : {}),
          ...(prepared.height ? { height: prepared.height } : {}),
        });
      }

      // Cleared before the await, so typing the next message is never blocked
      // on the network. The message is durable in the outbox by the time this
      // resolves, and the engine owns delivering it.
      setText("");
      for (const item of pending) URL.revokeObjectURL(item.url);
      setPending([]);

      await sync.enqueue(
        conversationId,
        encodeContent({ text: trimmed, attachments }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not send that. Check your connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-neutral-200 p-3 dark:border-neutral-800"
    >
      {pending.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto">
          {pending.map((item, index) => (
            <div key={item.url} className="relative shrink-0">
              <img
                src={item.url}
                alt=""
                className="h-16 w-16 rounded-md object-cover"
              />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label="Remove attachment"
                className="absolute -right-1 -top-1 rounded-full bg-neutral-900 px-1.5 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="flex gap-2">
        {/* accept without capture. `capture` forces the camera and removes the
            photo library, which on a phone is where the photo somebody wants
            to send almost always already is. */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          onInput={choose}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a photo"
          className="rounded-full px-2 text-xl leading-none text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          +
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message"
          className="flex-1 rounded-full border border-neutral-300 bg-white px-4 py-2 text-base outline-none focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={busy || (text.trim().length === 0 && pending.length === 0)}
          className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { conversations } = useConversations();
  const isDesktop = useIsDesktop();

  // Only when a thread is actually on screen. On a phone that is the same
  // thing as being selected; on desktop both panes are visible at once.
  useMarkRead(selected, session.user.id);

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

  if (settingsOpen) {
    return (
      <Settings
        session={session}
        onClose={() => setSettingsOpen(false)}
        // Revoking this device already invalidated the session server-side, so
        // the only honest thing left is the same local teardown as a sign-out.
        onSignedOut={onSignOut}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-50 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          messenger
        </span>
        <span className="flex items-center gap-3">
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Settings
          </button>
          <button
            onClick={onSignOut}
            className="text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Sign out
          </button>
        </span>
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
                <Timeline
                  conversationId={selected}
                  session={session}
                  conversation={current}
                />
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
