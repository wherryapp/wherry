// The sidebar's hubs list, nested under the conversation list.

import { Fragment } from "react";
import { classLabel } from "../hub-class";
import type { HubSummary } from "../../api/types";
import {
  Badge,
  BellOffIcon,
  ChevronLeftIcon,
  HeadphonesIcon,
  LockIcon,
  ClassPill,
} from "../kit";
import { HubAvatar } from "../HubAvatar";
import { HubRail } from "./HubRail";
import { groupChannels, hubAggregate } from "./channels";
import { reorderHubs } from "./hub-order";
import { useSidebarPrefs } from "./prefs";
import { indicatorSlot } from "./reorder";
import { useReorder } from "./useReorder";

/**
 * The sidebar's hubs: a section header that folds the lot, then each hub as
 * a header row opening its panel with its channels nested under it.
 * Channels are conversations, so selecting one opens the ordinary thread
 * view -- the section is navigation, not a second message surface.
 *
 * The section fold (2026-09-02) is the phone's answer to "hubs take up a
 * lot of space": below `md` the sidebar is one scroll surface with hubs
 * above the DMs, so three hubs' channels put every direct conversation
 * below the fold. **Since 2026-09-05 the fold shows a rail** (HubRail.tsx):
 * every hub as a picture in one sideways-scrolling row, and a tap on one
 * shows that hub's channels beneath the row -- just that hub's, never the
 * whole vertical list, which stays behind the section's own chevron. So
 * the compact state keeps every hub in reach and in sight, and the DMs
 * keep the screen.
 *
 * Channel categories (2026-09-05, migration 0029) render as small
 * headings inside a hub's channel list, collapsible, uncategorised
 * channels first and unheaded -- a hub with none looks exactly as it did.
 * Grouping is `channels.ts`'s pure `groupChannels`, shared with the hub
 * panel.
 *
 * Reordering hubs is hold-to-lift (useReorder.ts) in both the list and the
 * rail: press for HOLD_MS without moving, the hub lifts, drag, release. One
 * mechanism for a finger and a mouse alike, and one that cannot fire from
 * a click or a scroll -- the 2026-08-31 mouse-only drag started on 8px of
 * movement and is replaced by this. The order it writes is the account's
 * (hub-order.ts), so the phone and the desktop agree. The create form that used to sit
 * above the list moved to the compose panel (ui/Compose.tsx), which is
 * also what made the section's height stop depending on the feature-flag
 * fetch.
 */
export function HubsSection({
  hubs,
  unread,
  mentions,
  muted,
  occupancy,
  selected,
  onSelect,
  onOpenHub,
}: {
  hubs: HubSummary[];
  unread: Map<string, number>;
  /** Channels with an unread mention of this user -- the stronger badge. */
  mentions: Set<string>;
  /** Channel conversation ids the user has muted. */
  muted: Set<string>;
  /** Voice channels: who is in each right now. Empty when nobody is. */
  occupancy: ReadonlyMap<string, readonly string[]>;
  selected: string | null;
  onSelect: (conversationId: string) => void;
  onOpenHub: (hubId: string) => void;
}) {
  const { prefs, update } = useSidebarPrefs();

  const toggleCollapsed = (hubId: string) => {
    const next = prefs.collapsedHubIds.includes(hubId)
      ? prefs.collapsedHubIds.filter((id) => id !== hubId)
      : [...prefs.collapsedHubIds, hubId];
    update({ collapsedHubIds: next });
  };

  const collapsedCategoryIds = prefs.collapsedCategoryIds ?? [];
  const toggleCategory = (categoryId: string) => {
    const next = collapsedCategoryIds.includes(categoryId)
      ? collapsedCategoryIds.filter((id) => id !== categoryId)
      : [...collapsedCategoryIds, categoryId];
    update({ collapsedCategoryIds: next });
  };

  // The order belongs to the account (2026-09-05): written to the server,
  // optimistically applied here, and every other device's sidebar follows
  // on its next refresh. See hub-order.ts.
  const reorder = (next: HubSummary[]) => {
    void reorderHubs(next);
  };

  const list = useReorder({ items: hubs, axis: "y", onReorder: reorder });
  const listSlot = list.drag
    ? indicatorSlot(list.drag.fromIndex, list.drag.overIndex)
    : null;

  if (hubs.length === 0) return null;

  const sectionCollapsed = prefs.hubsSectionCollapsed === true;
  // The folded header's roll-up: every hub's count and mention flag, under
  // the same mute rule hubAggregate applies per hub.
  const total = hubs.reduce(
    (sum, hub) => {
      const agg = hubAggregate(hub, unread, mentions, muted);
      return { count: sum.count + agg.count, mentioned: sum.mentioned || agg.mentioned };
    },
    { count: 0, mentioned: false },
  );
  // The rail's open hub. A stale id (a hub since left) is simply nothing.
  const railHub = sectionCollapsed
    ? (hubs.find((hub) => hub.id === prefs.railHubId) ?? null)
    : null;

  const channelRows = (hub: HubSummary) => (
    <ChannelRows
      hub={hub}
      unread={unread}
      mentions={mentions}
      muted={muted}
      occupancy={occupancy}
      selected={selected}
      onSelect={onSelect}
      collapsedCategoryIds={collapsedCategoryIds}
      onToggleCategory={toggleCategory}
    />
  );

  return (
    // The Sidebar's wrapper owns the section's border and scrolling; this
    // root is padding only, so the section works inside either container.
    <div className="px-2 pb-2 pt-1">
      <div className="flex items-center gap-1 px-1">
        <button
          onClick={() => update({ hubsSectionCollapsed: !sectionCollapsed })}
          aria-expanded={!sectionCollapsed}
          className="flex min-w-0 flex-1 items-center gap-1 rounded py-1 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ChevronLeftIcon
            className={`h-3.5 w-3.5 transition-transform ${sectionCollapsed ? "rotate-180" : "-rotate-90"}`}
          />
          Hubs
        </button>
        {/* The roll-up stays on the header even with the rail showing:
            the rail's badges are per hub, and a hub scrolled out of view
            would otherwise take its count with it. */}
        {sectionCollapsed && total.mentioned && (
          <span
            aria-label="Mentions you"
            className="shrink-0 text-xs font-bold text-accent-600 dark:text-accent-400"
          >
            @
          </span>
        )}
        {sectionCollapsed && <Badge count={total.count} />}
      </div>
      {sectionCollapsed && (
        <>
          <HubRail
            hubs={hubs}
            unread={unread}
            mentions={mentions}
            muted={muted}
            openHubId={railHub?.id ?? null}
            onToggleHub={(hubId) =>
              update({ railHubId: prefs.railHubId === hubId ? null : hubId })
            }
            onReorder={reorder}
          />
          {railHub && (
            <div className="mt-1">
              {/* The open hub's name is the way to its panel here, the
                  same as a list header row; the rail icon itself is the
                  show/hide toggle. */}
              <button
                onClick={() => onOpenHub(railHub.id)}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {railHub.name}
                </span>
                {railHub.visibility !== "private" && (
                  <ClassPill label={classLabel(railHub.visibility)} />
                )}
                <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                  Details
                </span>
              </button>
              {channelRows(railHub)}
            </div>
          )}
        </>
      )}
      {!sectionCollapsed && hubs.map((hub, index) => {
        const collapsed = prefs.collapsedHubIds.includes(hub.id);
        const agg = hubAggregate(hub, unread, mentions, muted);
        const lifted = list.drag?.id === hub.id;
        // The whole block (header and channels) is the hit-test extent, so
        // a drop between two expanded hubs lands between them; the press
        // that starts the hold is the header row only.
        const { ref, ...press } = list.itemProps(hub.id, index);
        return (
          <Fragment key={hub.id}>
            {listSlot === index && (
              <div className="mx-1 mt-2 h-0.5 rounded bg-accent-500" />
            )}
            <div
              ref={ref}
              className={`${index === 0 ? "mt-1" : "mt-2"} ${
                lifted ? "relative z-10 rounded-lg bg-white shadow-lg dark:bg-neutral-900" : ""
              } ${list.holding === hub.id ? "opacity-70" : ""}`}
              style={
                lifted && list.drag
                  ? { transform: `translateY(${list.drag.offset}px) scale(1.02)` }
                  : undefined
              }
            >
            <div className="flex items-center gap-1" {...press}>
              <button
                onClick={() => toggleCollapsed(hub.id)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${hub.name}` : `Collapse ${hub.name}`}
                // Never let this bubble into the header's own pointerdown --
                // that is what arms the hold-to-lift, and the chevron must
                // not start it.
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:bg-neutral-800"
              >
                <ChevronLeftIcon
                  className={`h-3.5 w-3.5 transition-transform ${collapsed ? "rotate-180" : "-rotate-90"}`}
                />
              </button>
              <button
                onClick={() => onOpenHub(hub.id)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <HubAvatar hub={hub} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {hub.name}
                </span>
                {hub.visibility !== "private" && (
                  <ClassPill label={classLabel(hub.visibility)} />
                )}
              </button>
              {collapsed && agg.mentioned && (
                <span
                  aria-label="Mentions you"
                  className="shrink-0 text-xs font-bold text-accent-600 dark:text-accent-400"
                >
                  @
                </span>
              )}
              {collapsed && <Badge count={agg.count} />}
            </div>
            {/* No auto-expand when a collapsed hub holds the selected channel
                -- deliberate v1 choice; the badge above is the substitute. */}
            {!collapsed && channelRows(hub)}
            </div>
            {index === hubs.length - 1 && listSlot === hubs.length && (
              <div className="mx-1 mt-2 h-0.5 rounded bg-accent-500" />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * One hub's channels, grouped under its categories. Shared by the vertical
 * list and the rail's open hub, so the two never disagree about a row.
 */
function ChannelRows({
  hub,
  unread,
  mentions,
  muted,
  occupancy,
  selected,
  onSelect,
  collapsedCategoryIds,
  onToggleCategory,
}: {
  hub: HubSummary;
  unread: Map<string, number>;
  mentions: Set<string>;
  muted: Set<string>;
  occupancy: ReadonlyMap<string, readonly string[]>;
  selected: string | null;
  onSelect: (conversationId: string) => void;
  collapsedCategoryIds: readonly string[];
  onToggleCategory: (categoryId: string) => void;
}) {
  const groups = groupChannels(hub.channels, hub.categories ?? []);
  return (
    <div className="mt-0.5">
      {groups.map((group) => {
        const category = group.category;
        const collapsed =
          category !== null && collapsedCategoryIds.includes(category.id);
        // A collapsed heading carries its channels' roll-up, the way a
        // collapsed hub's header does.
        const agg = hubAggregate(group, unread, mentions, muted);
        return (
          <Fragment key={category?.id ?? "uncategorised"}>
            {category && (
              <button
                onClick={() => onToggleCategory(category.id)}
                aria-expanded={!collapsed}
                className="mt-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <ChevronLeftIcon
                  className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? "rotate-180" : "-rotate-90"}`}
                />
                <span className="min-w-0 flex-1 truncate">{category.name}</span>
                {collapsed && agg.mentioned && (
                  <span
                    aria-label="Mentions you"
                    className="shrink-0 text-xs font-bold normal-case tracking-normal text-accent-600 dark:text-accent-400"
                  >
                    @
                  </span>
                )}
                {collapsed && <Badge count={agg.count} />}
              </button>
            )}
            {!collapsed &&
              group.channels.map((channel) => {
                const count = unread.get(channel.id) ?? 0;
                const inRoom = occupancy.get(channel.id)?.length ?? 0;
                const isVoice = channel.kind === "voice";
                return (
                  <button
                    key={channel.id}
                    onClick={() => onSelect(channel.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors ${
                      selected === channel.id
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <span className="shrink-0 text-neutral-400 dark:text-neutral-500">
                      {isVoice ? (
                        <HeadphonesIcon className="h-3.5 w-3.5" />
                      ) : (
                        "#"
                      )}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        count > 0
                          ? "font-semibold text-neutral-900 dark:text-neutral-100"
                          : "text-neutral-700 dark:text-neutral-300"
                      }`}
                    >
                      {channel.title ?? (isVoice ? "voice" : "channel")}
                      {isVoice && inRoom > 0 && (
                        <span
                          aria-label={`${inRoom} in voice`}
                          className="ml-1.5 inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                        >
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {inRoom}
                        </span>
                      )}
                      {channel.posting === "moderators" && (
                        <LockIcon className="ml-1 inline h-3 w-3 align-[-1px] text-neutral-400 dark:text-neutral-500" />
                      )}
                    </span>
                    {muted.has(channel.id) && (
                      <BellOffIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
                    )}
                    {mentions.has(channel.id) && (
                      <span
                        aria-label="Mentions you"
                        className="shrink-0 text-xs font-bold text-accent-600 dark:text-accent-400"
                      >
                        @
                      </span>
                    )}
                    <Badge count={count} />
                  </button>
                );
              })}
          </Fragment>
        );
      })}
    </div>
  );
}
