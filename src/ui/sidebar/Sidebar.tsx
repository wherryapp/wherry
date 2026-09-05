// The conversation list: the sidebar's main body, with hubs nested above it.
//
// Desktop and mobile get different structures, not different classes: on
// desktop the hubs section and the DM list are two independent scroll
// containers separated by a height budget (auto until the divider ships, then
// user-set), because both lists must stay reachable no matter how long the
// other grows. Below md the sidebar is the whole screen and an inner
// scrollbar inside an outer one is exactly what a phone must not have -- so
// there it is one scroll surface, hubs above DMs.
//
// Nothing here starts anything any more: the "New conversation" box that
// topped both layouts, and the "New hub" button that topped the hubs, moved
// behind the list header's compose control (ui/Compose.tsx, 2026-09-02).
// The list is the list.

import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredSession } from "../../api/session";
import {
  useConversations,
  useHubs,
  useLatestMessages,
  useMentions,
  useSidebarPresence,
  useUnread,
} from "../hooks";
import {
  avatarHue,
  avatarKey,
  avatarSeed,
  conversationTitle,
  listTime,
  memberName,
} from "../format";
import { useIsDesktop } from "../viewport";
import { Badge, BellOffIcon } from "../kit";
import { UserAvatar } from "../UserAvatar";
import { onlineOthers, presenceStatusOf } from "../status";
import { StatusDot } from "../StatusDot";
import { HubsSection } from "./HubsSection";
import { ResizeHandle } from "./ResizeHandle";
import { useSidebarPrefs } from "./prefs";
import { reorderHubs } from "./hub-order";
import { rankConversations, recencyRanker, seedHubOrder } from "./rank";

export function ConversationList({
  session,
  selected,
  onSelect,
  onOpenHub,
  voiceOccupancy,
}: {
  session: StoredSession;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenHub: (hubId: string) => void;
  /** Who is in each voice channel (voice_presence), for the hub rows. */
  voiceOccupancy: ReadonlyMap<string, readonly string[]>;
}) {
  const { conversations } = useConversations();
  const { hubs } = useHubs();
  // Unread and previews are computed over everything -- channels included,
  // for the hub section's badges -- but the direct/group rows below exclude
  // channels, which render nested under their hub instead.
  const latest = useLatestMessages(conversations);
  const unread = useUnread(conversations, session.user.id);
  const mentions = useMentions(conversations, session.user.id);
  const muted = new Set(
    conversations.filter((c) => c.muted).map((c) => c.id),
  );
  // Most-recent activity first -- the latest renderable message's time, or
  // creation time for a conversation with no preview yet. The previews land
  // in one state commit, so the order flips at most once as they hydrate.
  // A different metric later is a new ranker factory in rank.ts, not a
  // change here.
  const directsAndGroups = useMemo(
    () =>
      rankConversations(
        conversations.filter((conversation) => conversation.kind !== "channel"),
        recencyRanker(latest),
      ),
    [conversations, latest],
  );
  // Online dots for every direct and group row (2026-09-03; 1:1 only before
  // that). Hub channels are deliberately excluded -- they are not in this
  // list at all, since they render under their hub -- and that exclusion is
  // load-bearing rather than incidental: the engine caps an ask at 50
  // conversations, but a channel's own member list can be hundreds, and the
  // server joins every member's devices per conversation asked about. A long
  // list of narrow rooms is fine; a wide one is what to avoid.
  //
  // Sorted so a recency reorder does not look like a new id list to the
  // hook, which would reset the map and re-ask on every incoming message.
  const presenceIds = useMemo(
    () => directsAndGroups.map((conversation) => conversation.id).sort(),
    [directsAndGroups],
  );
  const presence = useSidebarPresence(presenceIds);

  const isDesktop = useIsDesktop();
  const { prefs, update } = useSidebarPrefs();

  // A drag in progress renders from component state; storage is written once
  // on pointerup. Committing clears the live value in the same handler, so
  // the persisted height takes over in the same render batch.
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const hubsHeight = liveHeight ?? prefs.hubsHeightPx;
  const asideRef = useRef<HTMLElement>(null);
  const hubsRef = useRef<HTMLDivElement>(null);

  // The list arrives in the account's order (2026-09-05, migration 0030):
  // placed hubs first in their order, the rest newest first. Nothing is
  // applied on top any more. The one thing left of the device-local order
  // is seeding: a device that kept one before the account had any uploads
  // it once, then forgets it. Pure decision in rank.ts, three-way so a
  // summary from an older build (no sortOrder field) is waited on rather
  // than mistaken for "the account has an order".
  //
  // Nothing to retire means nothing to do -- and that early return is
  // load-bearing, not tidy: `update` hands out a fresh prefs object, so a
  // write of `[]` over an already-empty order re-ran this effect with a
  // new empty array, which wrote `[]` again, and React gave up on the
  // render loop with a blank page (caught on the first reload after the
  // change, 2026-09-05). Only a non-empty local order is ever written over.
  useEffect(() => {
    if (prefs.hubOrder.length === 0) return;
    const decision = seedHubOrder(hubs, prefs.hubOrder);
    if (decision.action === "wait") return;
    update({ hubOrder: [] });
    if (decision.action === "seed") void reorderHubs(decision.order);
  }, [hubs, prefs.hubOrder, update]);
  const orderedHubs = hubs;

  // Hoisted from HubsSection's own null-return so the bordered wrapper the
  // scroll containers need does not render as a stray rule around nothing.
  // Membership only -- no feature-flag term, so the section's presence is
  // settled by the store at first paint rather than by a fetch a beat later.
  const showHubs = hubs.length > 0;
  // Folded to its header row: content-sized, no budget, no divider.
  const hubsFolded = prefs.hubsSectionCollapsed === true;
  const hubsSection = (
    <HubsSection
      hubs={orderedHubs}
      unread={unread}
      mentions={mentions}
      muted={muted}
      occupancy={voiceOccupancy}
      selected={selected}
      onSelect={onSelect}
      onOpenHub={onOpenHub}
    />
  );

  const dmRows = (
    <>
      {directsAndGroups.length === 0 && (
        <p className="p-4 text-sm text-neutral-500 dark:text-neutral-400">
          No conversations yet.
        </p>
      )}

      {directsAndGroups.map((conversation) => {
          const preview = latest.get(conversation.id);
          // A photo with no caption still has to say something in the list,
          // and so does a message kind this build cannot render. A retracted
          // one says it was deleted rather than leaking what it used to say.
          const text = preview
            ? preview.retracted
              ? "Message deleted"
              : preview.content === "unsupported"
                ? "Needs a newer version"
                : preview.content
                  ? preview.content.text ||
                    (preview.content.attachments.length > 0 ? "Photo" : "")
                  : null
            : null;
          const count = unread.get(conversation.id) ?? 0;
          const isGroup = conversation.members.length > 2;

          // In a group the preview is ambiguous without a name -- "see you at
          // 6" from one of four people is half a message.
          const prefix =
            isGroup &&
            preview &&
            preview.message.senderUserId !== session.user.id
              ? `${memberName(conversation, preview.message.senderUserId)}: `
              : "";

          const title = conversationTitle(conversation, session.user.id);

          // The other member's id in a 1:1, for the online dot. Absent from
          // the presence map means unknown -- render nothing, never an
          // "offline" treatment; presence has no stored form on purpose.
          const otherId = !isGroup
            ? conversation.members.find(
                (member) => member.userId !== session.user.id,
              )?.userId
            : undefined;
          const snapshot = presence.get(conversation.id);
          const otherOnline =
            otherId !== undefined &&
            (snapshot?.online.includes(otherId) ?? false);
          // A group's dot says "somebody else is in here", and stays plain
          // green: a room has no single status, and colouring it by whoever
          // happens to be first in the list would be a claim about the room
          // that is really about one person. The count is deliberately not
          // put on the secondary line either -- that line is the message
          // preview, which is the more useful of the two, and Group details
          // is one tap away for who exactly.
          const groupOnline =
            isGroup &&
            onlineOthers(
              conversation.members.map((member) => member.userId),
              session.user.id,
              snapshot?.online,
            ).length > 0;

          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                selected === conversation.id
                  ? "bg-neutral-100 dark:bg-neutral-800"
                  : // neutral-800, not the "neutral-850" that sat here
                    // silently generating no rule -- the scale has no 850.
                    "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              {/* A relative wrapper rather than a prop on kit's Avatar:
                  the dot is this row's concern, not every avatar's. Styled
                  like the announcement dot on the Settings avatar -- same
                  shape and border, green for "here now". */}
              <span className="relative shrink-0">
                <UserAvatar
                  name={title}
                  userId={avatarSeed(conversation, session.user.id)}
                  hue={avatarHue(conversation, session.user.id)}
                  avatarKey={avatarKey(conversation, session.user.id)}
                />
                {otherOnline && otherId !== undefined && (
                  <StatusDot
                    status={presenceStatusOf(otherId, snapshot?.statuses)}
                    size="sm"
                  />
                )}
                {groupOnline && <StatusDot status="online" size="sm" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100 ${
                      count > 0 ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {title}
                  </span>
                  {/* Timestamp and the mute icon share this slot -- the row
                      is laid out so either fits without moving the name. */}
                  {conversation.muted && (
                    <BellOffIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
                  )}
                  {preview && (
                    <span className="shrink-0 text-[0.6875rem] text-neutral-500 dark:text-neutral-400">
                      {listTime(preview.message.sentAt)}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                      count > 0
                        ? "text-neutral-700 dark:text-neutral-300"
                        : "text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    {preview
                      ? `${prefix}${text ?? "Encrypted message"}`
                      : "No messages yet"}
                  </span>
                  {mentions.has(conversation.id) && (
                    <span
                      aria-label="Mentions you"
                      className="shrink-0 text-xs font-bold text-accent-600 dark:text-accent-400"
                    >
                      @
                    </span>
                  )}
                  <Badge count={count} />
                </span>
              </span>
            </button>
          );
        })}
    </>
  );

  if (!isDesktop) {
    return (
      <aside className="flex min-h-0 w-full shrink-0 flex-col bg-white dark:bg-neutral-900">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {showHubs && (
            <div className="border-b border-neutral-200 dark:border-neutral-800">
              {hubsSection}
            </div>
          )}
          {dmRows}
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={asideRef}
      className="flex min-h-0 w-full shrink-0 flex-col bg-white md:w-72 md:border-r md:border-neutral-200 dark:bg-neutral-900 dark:md:border-neutral-800"
    >
      {showHubs && (
        <>
          <div
            ref={hubsRef}
            className="min-h-0 shrink-0 overflow-y-auto border-b border-neutral-200 dark:border-neutral-800"
            // Auto: content-sized until the cap, so DMs keep the majority.
            // Fixed: the user's height, with the CSS max doing the clamping
            // when the window is too small -- max-height beats height, so
            // the stored preference is never rewritten by a shrink the user
            // didn't drag, and regrowing the window restores it.
            // Folded: the rail and, if one is open, a hub's channels --
            // content-sized under the auto cap, and the stored height is
            // left untouched for when the section opens again. (Header row
            // alone until 2026-09-05; the rail is what the fold shows now.)
            style={
              hubsFolded || hubsHeight === null
                ? { maxHeight: "45%" }
                : {
                    height: `${hubsHeight}px`,
                    maxHeight: "calc(100% - 10rem)",
                  }
            }
          >
            {hubsSection}
          </div>
          {!hubsFolded && (
            <ResizeHandle
              asideRef={asideRef}
              hubsRef={hubsRef}
              height={prefs.hubsHeightPx}
              onLiveResize={setLiveHeight}
              onCommit={(px) => {
                setLiveHeight(null);
                update({ hubsHeightPx: px });
              }}
              onReset={() => {
                setLiveHeight(null);
                update({ hubsHeightPx: null });
              }}
            />
          )}
        </>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">{dmRows}</div>
    </aside>
  );
}
