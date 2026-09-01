import { useEffect, useRef, useState } from "react";
import { Settings } from "./Settings";
import { Friends } from "./Friends";
import { HubDetails } from "./HubDetails";
import { GroupDetails } from "./GroupDetails";
import { JoinInvite } from "./JoinInvite";
import { PinsPanel } from "./PinsPanel";
import { Presence, Timeline, TypingLine } from "./Timeline";
import { Composer } from "./Composer";
import { type EditDraft, type ReplyDraft } from "./drafts";
import { avatarHue, avatarSeed, conversationTitle } from "./format";
import { useIsDesktop } from "./viewport";
import { ConversationList } from "./sidebar/Sidebar";
import {
  fetchArchive,
  markConversationRead,
  muteConversation,
  unmuteConversation,
} from "../api/client";
import { decodeBase64 } from "../api/base64";
import { PROTOCOL_PUBLIC } from "../crypto/provider";
import { store } from "../store";
import type { StoredSession } from "../api/session";
import { sync } from "../sync/engine";
import { clearNotificationsFor } from "../sync/push";
import {
  useAnnouncements,
  useConversations,
  useHubs,
  useSyncStatus,
  useTimeline,
  useUnread,
} from "./hooks";
import { QuickSwitcher } from "./QuickSwitcher";
import {
  Avatar,
  BackButton,
  BellIcon,
  BellOffIcon,
  Button,
  IconButton,
  LockIcon,
  PinIcon,
  PublicPill,
  UsersIcon,
} from "./kit";

// eventText, readCount, readLabel, deliveredCount, deliveredLabel, time,
// escapeRegex and highlightMentions moved to Timeline.tsx, the only file
// that used them.

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The banner for states worth interrupting the layout for.
 *
 * Deliberately says nothing about a routine sync. The loop ticks every two
 * seconds as a fallback, stretched to thirty while the realtime socket is
 * healthy, so a "Syncing…" banner would insert and remove itself from the
 * layout on every pass either way -- the content below it shifting down and
 * back on a rhythm the reader would learn to see. That is not a status
 * indicator, it is a flicker, and the information it conveys ("a sync pass
 * happened") is worth nothing to the person reading the conversation.
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

/**
 * A commit mismatch between this build and what the server reports it is
 * running -- see sync/engine.ts's #checkForUpdate. Never auto-reloads: a
 * deploy landing mid-compose must not lose a draft on its own, so this only
 * ever offers the reload, same as the tab would ask a person to do by hand.
 *
 * Names the server's version when `/health` reported one worth naming
 * (`status.updateVersion`, set only alongside `updateAvailable` -- see the
 * type's comment in sync/engine.ts); otherwise falls back to today's
 * wording, which is every build before tagging starts.
 */
function UpdateBanner() {
  const status = useSyncStatus();

  if (!status.updateAvailable) return null;

  const label = status.updateVersion
    ? `Version ${status.updateVersion} is available.`
    : "A new version is available.";

  return (
    <div className="flex items-center justify-between gap-2 border-b border-accent-100 bg-accent-50 px-4 py-1.5 text-xs text-accent-900 motion-safe:animate-fade-in dark:border-accent-900 dark:bg-accent-950 dark:text-accent-100">
      <span>{label}</span>
      <button
        onClick={() => window.location.reload()}
        className="shrink-0 font-medium underline"
      >
        Reload
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting a conversation
// ---------------------------------------------------------------------------

// ContactCheckboxRow moved to ContactRow.tsx when HubDetails became its
// third user -- see that file's comment.

// GroupDetails moved to GroupDetails.tsx.

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
  const { items } = useTimeline(conversationId, selfUserId);

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

      // Reading a conversation makes its OS notification stale -- close it
      // now rather than when the person finds it later. Independent of the
      // server call below succeeding: seen is seen.
      clearNotificationsFor(conversationId);

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

// JoinInvite moved to JoinInvite.tsx; PinsPanel moved to PinsPanel.tsx.
// ReplyDraft, EditDraft and excerptOf moved to drafts.ts -- PinsPanel needs
// excerptOf too, and it moved out of this file before the timeline did.

// ConversationList (with NewConversation, NewHub and HubsSection) moved to
// sidebar/Sidebar.tsx, sidebar/NewConversation.tsx, sidebar/NewHub.tsx and
// sidebar/HubsSection.tsx.

// QUICK_REACTIONS, myReaction, PressPointerEvent, TAP_MOVE_PX, TAP_MAX_MS,
// Bubble, Notice, RUN_GAP_MS, runIdentity, sameRun, Timeline, Presence and
// TypingLine all moved to Timeline.tsx.

// Composer moved to Composer.tsx.

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Chat({
  session,
  onSignOut,
  inviteToken = null,
  onInviteHandled = () => {},
}: {
  session: StoredSession;
  onSignOut: () => void;
  /** A hub invite from a /join/<token> link, handled before anything else. */
  inviteToken?: string | null;
  onInviteHandled?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  /** Which hub's panel is open, by hub id -- the channel-class sibling of
   *  groupDetailsOpen. */
  const [hubDetailsFor, setHubDetailsFor] = useState<string | null>(null);
  /** Which channel's pin list is open. */
  const [pinsFor, setPinsFor] = useState<string | null>(null);
  /** A message id the open timeline should scroll to -- search/pin jumps. */
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  // Owned here rather than by Timeline or Composer, because it is the one
  // piece of state they share: the bar's Reply action sets it, the
  // composer renders and consumes it. Reset on switching conversations --
  // a reply drafted in one thread must not attach to another.
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  // Edit shares the composer's context-bar slot, so the two are exclusive:
  // starting either clears the other.
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  useEffect(() => {
    setReplyDraft(null);
    setEditDraft(null);
  }, [selected]);
  const [muteBusy, setMuteBusy] = useState(false);
  const { conversations } = useConversations();
  const { hubs } = useHubs();
  const isDesktop = useIsDesktop();
  // Only the count; the list itself renders in Settings. Zero whenever the
  // announcements flag is off, so the dot is dark exactly when the feature is.
  const { unread: unreadAnnouncements } = useAnnouncements();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // The browser tab carries the total unread, the way every messenger's tab
  // does. Muted conversations are excluded -- for the count, mute means what
  // it means for push and for the collapsed-hub roll-up: not worth waking
  // anybody for. The store's own unread bookkeeping is untouched by mute.
  const unreadByConversation = useUnread(conversations, session.user.id);
  useEffect(() => {
    let total = 0;
    for (const conversation of conversations) {
      if (conversation.muted) continue;
      total += unreadByConversation.get(conversation.id) ?? 0;
    }
    document.title =
      total > 0 ? `(${total > 99 ? "99+" : total}) messenger` : "messenger";
    return () => {
      document.title = "messenger";
    };
  }, [conversations, unreadByConversation]);

  // Global keys. Ctrl/Cmd+K opens the switcher from anywhere in the main
  // view, composer included; it stays out of the full-screen panels because
  // they early-return their own trees and the dialog could not render over
  // them. Plain Escape backs out of a thread only on a phone -- desktop
  // shows both panes, so deselecting would just empty one -- and only when
  // the key is not already someone else's: a focused field, an open panel,
  // or the switcher itself all take precedence.
  useEffect(() => {
    const panelOpen =
      settingsOpen ||
      friendsOpen ||
      groupDetailsOpen ||
      hubDetailsFor !== null ||
      pinsFor !== null;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (panelOpen) return;
        event.preventDefault();
        setSwitcherOpen((open) => !open);
        return;
      }
      if (event.key !== "Escape" || switcherOpen || panelOpen) return;
      if (isDesktop || selected === null) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    switcherOpen,
    isDesktop,
    selected,
    settingsOpen,
    friendsOpen,
    groupDetailsOpen,
    hubDetailsFor,
    pinsFor,
  ]);

  // Only when a thread is actually on screen. On a phone that is the same
  // thing as being selected; on desktop both panes are visible at once.
  useMarkRead(selected, session.user.id);

  // Open the newest conversation on first load, so the app does not start on
  // an empty panel when there is something to show.
  //
  // Desktop only. On a phone the two panes are two screens, and pre-selecting
  // means opening the app *inside* a thread with a back button as the only
  // clue that a list exists.
  //
  // Fires once per MOUNT, not once per isDesktop-becomes-true: `isDesktop` is
  // a width media query, and an iPhone in landscape is wider than `md`, so
  // without the ref below this effect re-ran on every rotation past the
  // breakpoint and wrote `selected` again. Rotating back to portrait then
  // left that selection standing -- the phone landed inside a thread it
  // never opened. The ref latches only once the selection actually happens
  // (conversations can still be loading when this first runs), so a genuine
  // first desktop load still works.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (!isDesktop) return;
    if (selected !== null || !conversations[0]) return;
    autoSelectedRef.current = true;
    setSelected(conversations[0].id);
  }, [conversations, selected, isDesktop]);

  const current = conversations.find((c) => c.id === selected);

  // The channel's hub-side settings and the viewer's role, from the hubs
  // summary the engine keeps -- the mirror of the server's matrix, for
  // showing controls; the server enforces for real.
  const currentHub = hubs.find((hub) => hub.id === current?.hubId);
  const channelInfo = currentHub?.channels.find(
    (channel) => channel.id === selected,
  );
  const canModerate =
    currentHub !== undefined && currentHub.role !== "member";
  const restricted =
    channelInfo?.posting === "moderators" && !canModerate;

  /**
   * The jump half of search and pins: store the archived message locally (a
   * public channel's payload is handed over readable), pull a little context
   * around it, then open the channel scrolled to it. A private pin carries
   * no payload; the jump then shows whatever this device already holds.
   */
  async function jumpToArchived(target: {
    conversationId: string;
    messageId: string;
    payload: string | null;
    senderUserId: string;
    senderDeviceId: string;
    sentAt: string;
  }): Promise<void> {
    if (target.payload !== null) {
      await store.putMessages([
        {
          messageId: target.messageId,
          conversationId: target.conversationId,
          senderUserId: target.senderUserId,
          senderDeviceId: target.senderDeviceId,
          protocolVersion: PROTOCOL_PUBLIC,
          payload: decodeBase64(target.payload),
          sentAt: target.sentAt,
        },
      ]);
      try {
        const [older, newer] = await Promise.all([
          fetchArchive({
            conversationId: target.conversationId,
            cursor: target.messageId,
            limit: 25,
          }),
          fetchArchive({
            conversationId: target.conversationId,
            after: target.messageId,
            limit: 25,
          }),
        ]);
        const context = [...older.entries, ...newer.entries]
          .filter((entry) => entry.protocolVersion === PROTOCOL_PUBLIC)
          .map((entry) => ({
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            senderUserId: entry.senderUserId,
            senderDeviceId: entry.senderDeviceId,
            protocolVersion: entry.protocolVersion,
            payload: decodeBase64(entry.payload),
            sentAt: entry.sentAt,
          }));
        if (context.length > 0) await store.putMessages(context);
      } catch {
        // Context is a nicety; the hit itself is already stored.
      }
      sync.notifyMessagesChanged([target.conversationId]);
    }
    setSelected(target.conversationId);
    setJumpTarget(target.messageId);
  }

  /**
   * Mutation + refresh, the same shape as GroupDetails' saveTitle/removeOne:
   * call the endpoint, then nudge the conversation list so the toggle's new
   * state is what the store reports, rather than optimistically flipping
   * local state that a failed request would leave wrong.
   */
  async function toggleMute(conversationId: string, muted: boolean): Promise<void> {
    setMuteBusy(true);
    try {
      if (muted) await unmuteConversation(conversationId);
      else await muteConversation(conversationId);
      sync.invalidateConversations();
    } catch (caught) {
      console.warn("mute toggle failed", caught);
    } finally {
      setMuteBusy(false);
    }
  }

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

  if (inviteToken) {
    return (
      <JoinInvite
        token={inviteToken}
        onDone={(channelId) => {
          onInviteHandled();
          if (channelId) setSelected(channelId);
        }}
      />
    );
  }

  if (pinsFor !== null && current?.hubId) {
    return (
      <PinsPanel
        hubId={current.hubId}
        conversationId={pinsFor}
        canModerate={canModerate}
        onClose={() => setPinsFor(null)}
        onJump={(pin) => {
          setPinsFor(null);
          void jumpToArchived({
            conversationId: pin.conversationId,
            messageId: pin.messageId,
            payload: pin.payload,
            senderUserId: pin.senderUserId,
            senderDeviceId: pin.senderDeviceId,
            sentAt: pin.sentAt,
          });
        }}
      />
    );
  }

  if (friendsOpen) {
    return (
      <Friends
        onClose={() => setFriendsOpen(false)}
        onOpenConversation={(id) => {
          setSelected(id);
          setFriendsOpen(false);
        }}
      />
    );
  }

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

  if (groupDetailsOpen && current) {
    return (
      <GroupDetails
        conversation={current}
        selfUserId={session.user.id}
        onClose={() => setGroupDetailsOpen(false)}
      />
    );
  }

  if (hubDetailsFor !== null) {
    return (
      <HubDetails
        hubId={hubDetailsFor}
        selfUserId={session.user.id}
        onClose={() => setHubDetailsFor(null)}
        onOpenChannel={(conversationId, jumpToHit) => {
          setHubDetailsFor(null);
          if (jumpToHit) {
            void jumpToArchived({
              conversationId,
              messageId: jumpToHit.messageId,
              payload: jumpToHit.payload,
              senderUserId: jumpToHit.senderUserId,
              senderDeviceId: jumpToHit.senderDeviceId,
              sentAt: jumpToHit.sentAt,
            });
          } else {
            setSelected(conversationId);
          }
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-50 dark:bg-neutral-950">
      {/* The app header is the LIST's header: a title and two controls, the
          shape a phone expects, instead of the row of webpage links this
          used to be. On a phone with a thread open it does not render at
          all -- the thread's own header is the only chrome -- which is what
          `showList` already means. Sign out moved into Settings; it is a
          rare act and was sitting on the most valuable row of the screen. */}
      {showList && (
        <header className="flex items-center justify-between border-b border-neutral-200 bg-white py-2 pl-4 pr-2 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            Chats
          </span>
          <span className="flex items-center gap-1">
            <IconButton label="Friends" onClick={() => setFriendsOpen(true)}>
              <UsersIcon />
            </IconButton>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label={
                unreadAnnouncements > 0
                  ? `Settings — ${unreadAnnouncements} unread ${
                      unreadAnnouncements === 1 ? "announcement" : "announcements"
                    }`
                  : "Settings"
              }
              className="relative rounded-full p-1 transition-opacity hover:opacity-80"
            >
              <Avatar
                size="sm"
                name={session.user.displayName}
                userId={session.user.id}
                hue={session.user.avatarHue}
              />
              {unreadAnnouncements > 0 && (
                <span className="absolute right-0 top-0 block h-2.5 w-2.5 rounded-full border-2 border-white bg-accent-600 dark:border-neutral-900" />
              )}
            </button>
          </span>
        </header>
      )}

      <StatusLine />
      <UpdateBanner />

      <div className="flex min-h-0 flex-1">
        {showList && (
          <ConversationList
            session={session}
            selected={selected}
            onSelect={setSelected}
            onOpenHub={setHubDetailsFor}
          />
        )}

        {showThread && (
          <main className="flex min-w-0 flex-1 flex-col bg-white motion-safe:animate-panel-in dark:bg-neutral-900">
            {selected !== null ? (
              <>
                <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
                  {!isDesktop && (
                    <BackButton
                      onClick={() => setSelected(null)}
                      label="Back to conversations"
                    />
                  )}
                  {current && (
                    <Avatar
                      size="sm"
                      name={conversationTitle(current, session.user.id)}
                      userId={avatarSeed(current, session.user.id)}
                      hue={avatarHue(current, session.user.id)}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      <span className="min-w-0 truncate">
                        {current?.kind === "channel" && (
                          <span className="mr-0.5 text-neutral-400 dark:text-neutral-500">
                            #
                          </span>
                        )}
                        {channelInfo?.posting === "moderators" && (
                          <LockIcon className="mr-0.5 inline h-3.5 w-3.5 align-[-2px] text-neutral-400 dark:text-neutral-500" />
                        )}
                        {current
                          ? conversationTitle(current, session.user.id)
                          : "Conversation"}
                      </span>
                      {current?.hubVisibility === "public" && <PublicPill />}
                    </span>
                    {channelInfo?.topic && (
                      <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                        {channelInfo.topic}
                      </span>
                    )}
                    <Presence
                      conversationId={selected}
                      conversation={current}
                    />
                  </span>
                  {current?.kind === "channel" && current.hubId && (
                    <IconButton
                      label="Pinned messages"
                      onClick={() => setPinsFor(selected)}
                      className="shrink-0"
                    >
                      <PinIcon />
                    </IconButton>
                  )}
                  {current && (
                    <IconButton
                      label={current.muted ? "Unmute conversation" : "Mute conversation"}
                      onClick={() => toggleMute(current.id, current.muted)}
                      disabled={muteBusy}
                      className="shrink-0"
                    >
                      {current.muted ? <BellOffIcon /> : <BellIcon />}
                    </IconButton>
                  )}
                  {current?.kind === "group" && (
                    <Button
                      variant="ghost"
                      onClick={() => setGroupDetailsOpen(true)}
                      className="shrink-0"
                    >
                      Details
                    </Button>
                  )}
                  {current?.kind === "channel" && current.hubId && (
                    <Button
                      variant="ghost"
                      onClick={() => setHubDetailsFor(current.hubId!)}
                      className="shrink-0"
                    >
                      Hub
                    </Button>
                  )}
                </div>
                <Timeline
                  conversationId={selected}
                  session={session}
                  conversation={current}
                  onReply={(draft) => {
                    setEditDraft(null);
                    setReplyDraft(draft);
                  }}
                  onEdit={(draft) => {
                    setReplyDraft(null);
                    setEditDraft(draft);
                  }}
                  moderation={
                    current?.kind === "channel" && current.hubId && canModerate
                      ? {
                          hubId: current.hubId,
                          isPublic: current.hubVisibility === "public",
                        }
                      : undefined
                  }
                  canPost={!restricted}
                  jumpTo={jumpTarget}
                  onJumped={() => setJumpTarget(null)}
                />
                <TypingLine
                  conversationId={selected}
                  conversation={current}
                />
                {restricted ? (
                  <div className="border-t border-neutral-200 p-3 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                    Only moderators can post in this channel.
                  </div>
                ) : (
                  <Composer
                    conversationId={selected}
                    publicChannel={current?.hubVisibility === "public"}
                    members={(current?.members ?? [])
                      .filter((member) => member.userId !== session.user.id)
                      .map((member) => ({
                        userId: member.userId,
                        name: member.displayName || member.username,
                        username: member.username,
                      }))}
                    slowmodeSeconds={
                      canModerate ? null : (channelInfo?.slowmodeSeconds ?? null)
                    }
                    reply={replyDraft}
                    onClearReply={() => setReplyDraft(null)}
                    edit={editDraft}
                    onClearEdit={() => setEditDraft(null)}
                  />
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">
                Pick a conversation, or start a new one.
              </div>
            )}
          </main>
        )}
      </div>

      {switcherOpen && (
        <QuickSwitcher
          conversations={conversations}
          hubs={hubs}
          selfId={session.user.id}
          onPick={setSelected}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
