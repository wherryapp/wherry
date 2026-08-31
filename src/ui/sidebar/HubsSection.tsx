// The sidebar's hubs list, nested under the conversation list.

import type { HubSummary } from "../../api/types";
import { Avatar, Badge, BellOffIcon, ChevronLeftIcon, LockIcon } from "../kit";
import { NewHub } from "./NewHub";
import { useSidebarPrefs } from "./prefs";

/**
 * A collapsed hub's roll-up: unread count and mention flag across its
 * channels, so the header still carries the signal a collapsed list hides.
 * Muted channels are excluded from the count -- that is what mute means --
 * but a mention surfaces regardless, the stronger signal, same reasoning as
 * mention-gated push.
 */
function hubAggregate(
  hub: HubSummary,
  unread: Map<string, number>,
  mentions: Set<string>,
  muted: Set<string>,
): { count: number; mentioned: boolean } {
  let count = 0;
  let mentioned = false;
  for (const channel of hub.channels) {
    if (!muted.has(channel.id)) count += unread.get(channel.id) ?? 0;
    if (mentions.has(channel.id)) mentioned = true;
  }
  return { count, mentioned };
}

/**
 * The sidebar's hubs: each hub is a header row opening its panel, with its
 * channels nested under it. Channels are conversations, so selecting one
 * opens the ordinary thread view -- the section is navigation, not a second
 * message surface.
 */
export function HubsSection({
  hubs,
  canCreate,
  unread,
  mentions,
  muted,
  selected,
  onSelect,
  onOpenHub,
}: {
  hubs: HubSummary[];
  /** The `hubs` feature flag -- gates the create form, not the list. */
  canCreate: boolean;
  unread: Map<string, number>;
  /** Channels with an unread mention of this user -- the stronger badge. */
  mentions: Set<string>;
  /** Channel conversation ids the user has muted. */
  muted: Set<string>;
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

  if (hubs.length === 0 && !canCreate) return null;

  return (
    // The Sidebar's wrapper owns the section's border and scrolling; this
    // root is padding only, so the section works inside either container.
    <div className="p-3">
      {canCreate && <NewHub onOpened={onSelect} />}
      {hubs.map((hub) => {
        const collapsed = prefs.collapsedHubIds.includes(hub.id);
        const agg = hubAggregate(hub, unread, mentions, muted);
        return (
          <div key={hub.id} className={canCreate || hub.id !== hubs[0]?.id ? "mt-3" : ""}>
            <div className="flex items-center gap-1">
              <button
                onClick={() => toggleCollapsed(hub.id)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${hub.name}` : `Collapse ${hub.name}`}
                // Never let this bubble into the header's own pointerdown --
                // a later change arms drag-reorder there, and the chevron
                // must not trigger it.
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
                {/* The hub id seeds the colour, so the identity survives renames
                    -- the cheap identicon tier; uploaded icons stay deferred. */}
                <Avatar size="sm" name={hub.name} userId={hub.id} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {hub.name}
                </span>
                {hub.visibility === "public" && (
                  <span className="shrink-0 rounded-full border border-neutral-300 px-1.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    Public
                  </span>
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
            {!collapsed && (
              <div className="mt-0.5">
                {hub.channels.map((channel) => {
                  const count = unread.get(channel.id) ?? 0;
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
                        #
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          count > 0
                            ? "font-semibold text-neutral-900 dark:text-neutral-100"
                            : "text-neutral-700 dark:text-neutral-300"
                        }`}
                      >
                        {channel.title ?? "channel"}
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
