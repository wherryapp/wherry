// The conversation list: the sidebar's main body, with hubs nested above it.
//
// Desktop and mobile get different structures, not different classes: on
// desktop the hubs section and the DM list are two independent scroll
// containers separated by a height budget (auto until the divider ships, then
// user-set), because both lists must stay reachable no matter how long the
// other grows. Below md the sidebar is the whole screen and an inner
// scrollbar inside an outer one is exactly what a phone must not have -- so
// there it is one scroll surface, hubs above DMs.

import { useMemo, useRef, useState } from "react";
import type { StoredSession } from "../../api/session";
import {
  useConversations,
  useFeatures,
  useHubs,
  useLatestMessages,
  useMentions,
  useSidebarPresence,
  useUnread,
} from "../hooks";
import {
  avatarHue,
  avatarSeed,
  conversationTitle,
  listTime,
  memberName,
} from "../format";
import { useIsDesktop } from "../viewport";
import { Avatar, Badge, BellOffIcon } from "../kit";
import { HubsSection } from "./HubsSection";
import { NewConversation } from "./NewConversation";
import { ResizeHandle } from "./ResizeHandle";
import { useSidebarPrefs } from "./prefs";
import { orderHubs, rankConversations, recencyRanker } from "./rank";

export function ConversationList({
  session,
  selected,
  onSelect,
  onOpenHub,
}: {
  session: StoredSession;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenHub: (hubId: string) => void;
}) {
  const { conversations } = useConversations();
  const { hubs } = useHubs();
  const features = useFeatures();
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
  // Online dots for 1:1 rows only in v1 -- a group's "2 of 7 online" is a
  // different design, deferred. Two members rather than kind === "direct",
  // matching the isGroup check below: groups shipped without a kind change.
  // Sorted so a recency reorder does not look like a new id list to the
  // hook, which would reset the map and re-ask on every incoming message.
  const dmIds = useMemo(
    () =>
      directsAndGroups
        .filter((conversation) => conversation.members.length === 2)
        .map((conversation) => conversation.id)
        .sort(),
    [directsAndGroups],
  );
  const presence = useSidebarPresence(dmIds);

  const isDesktop = useIsDesktop();
  const { prefs, update } = useSidebarPrefs();

  // A drag in progress renders from component state; storage is written once
  // on pointerup. Committing clears the live value in the same handler, so
  // the persisted height takes over in the same render batch.
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const hubsHeight = liveHeight ?? prefs.hubsHeightPx;
  const asideRef = useRef<HTMLElement>(null);
  const hubsRef = useRef<HTMLDivElement>(null);

  // The user's manual order over the server's newest-first default; hubs
  // joined since the last reorder append after the ordered ones.
  const orderedHubs = useMemo(
    () => orderHubs(hubs, prefs.hubOrder),
    [hubs, prefs.hubOrder],
  );

  // Hoisted from HubsSection's own null-return so the bordered wrapper the
  // scroll containers need does not render as a stray rule around nothing.
  const showHubs = hubs.length > 0 || features.hubs;
  const hubsSection = (
    <HubsSection
      hubs={orderedHubs}
      canCreate={features.hubs}
      unread={unread}
      mentions={mentions}
      muted={muted}
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
          const otherOnline =
            otherId !== undefined &&
            (presence.get(conversation.id)?.includes(otherId) ?? false);

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
                <Avatar
                  name={title}
                  userId={avatarSeed(conversation, session.user.id)}
                  hue={avatarHue(conversation, session.user.id)}
                />
                {otherOnline && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full border-2 border-white bg-green-500 dark:border-neutral-900"
                  />
                )}
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
                    <span className="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
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
        <div className="shrink-0 border-b border-neutral-200 p-3 dark:border-neutral-800">
          <NewConversation session={session} onOpened={onSelect} />
        </div>
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
      <div className="shrink-0 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <NewConversation session={session} onOpened={onSelect} />
      </div>

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
            style={
              hubsHeight === null
                ? { maxHeight: "45%" }
                : {
                    height: `${hubsHeight}px`,
                    maxHeight: "calc(100% - 10rem)",
                  }
            }
          >
            {hubsSection}
          </div>
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
        </>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">{dmRows}</div>
    </aside>
  );
}
