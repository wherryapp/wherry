// The sidebar's hubs list, nested under the conversation list.

import { Fragment, useRef, useState } from "react";
import type { HubSummary } from "../../api/types";
import { Avatar, Badge, BellOffIcon, ChevronLeftIcon, LockIcon } from "../kit";
import { NewHub } from "./NewHub";
import { useSidebarPrefs } from "./prefs";
import { moveItem } from "./rank";

/**
 * How far a mouse must travel vertically before a press on a hub header
 * becomes a reorder drag rather than a click -- the same discrimination the
 * message bubbles use for tap-vs-scroll, for the same reason.
 */
const DRAG_START_PX = 8;

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

  // Drag-to-reorder. Mouse only (pointerType, never the user agent): touch
  // keeps plain tap-to-open, and long-press reorder is deferred. A press on
  // a hub header arms window-level move/up listeners that own the whole
  // lifecycle; crossing DRAG_START_PX promotes the press to a drag.
  // Window listeners rather than row handlers or pointer capture, for two
  // reasons hit in testing: a fast drag can leave the pressed row before a
  // single move event fires inside it, and capturing at pointerdown would
  // retarget pointerup away from the header button and swallow the click
  // that opens the hub panel. `overIndex` is the insertion slot: the count
  // of block midpoints above the pointer.
  //
  // The authoritative drag lives in a ref, mirrored to state only for
  // rendering: a fast drag delivers its pointermove and pointerup in the
  // same frame, and reading the state closure would still see the pre-drag
  // null at pointerup and drop nothing.
  const dragRef = useRef<{
    hubId: string;
    fromIndex: number;
    overIndex: number;
  } | null>(null);
  const [drag, setDragView] = useState<typeof dragRef.current>(null);
  const setDrag = (next: typeof dragRef.current) => {
    dragRef.current = next;
    setDragView(next);
  };
  const suppressClick = useRef(false);
  const blockRefs = useRef(new Map<string, HTMLDivElement | null>());

  const clearDrag = () => {
    setDrag(null);
  };

  const hitTest = (clientY: number): number => {
    let over = 0;
    for (const hub of hubs) {
      const rect = blockRefs.current.get(hub.id)?.getBoundingClientRect();
      if (rect && clientY > rect.top + rect.height / 2) over++;
    }
    return over;
  };

  const dropTo = (fromIndex: number, overIndex: number) => {
    // Only currently-present ids are written -- this is what prunes the ids
    // of hubs since left from the stored order.
    update({
      hubOrder: moveItem(hubs, fromIndex, overIndex).map((hub) => hub.id),
    });
  };

  const beginPress = (
    hubId: string,
    index: number,
    event: React.PointerEvent,
  ) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (dragRef.current) return;
    // A fresh press also clears a stale suppress flag, so an aborted drag
    // can never swallow the next click.
    suppressClick.current = false;
    const startY = event.clientY;
    const pointerId = event.pointerId;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      try {
        const active = dragRef.current;
        if (active) {
          setDrag({ ...active, overIndex: hitTest(e.clientY) });
        } else if (Math.abs(e.clientY - startY) > DRAG_START_PX) {
          suppressClick.current = true;
          setDrag({ hubId, fromIndex: index, overIndex: hitTest(e.clientY) });
        }
      } catch {
        // Never leave the window listeners wedged on broken state.
        cleanup();
        clearDrag();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      try {
        const active = dragRef.current;
        if (active) dropTo(active.fromIndex, hitTest(e.clientY));
      } finally {
        clearDrag();
      }
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cleanup();
      clearDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  if (hubs.length === 0 && !canCreate) return null;

  return (
    // The Sidebar's wrapper owns the section's border and scrolling; this
    // root is padding only, so the section works inside either container.
    <div className="p-3">
      {canCreate && <NewHub onOpened={onSelect} />}
      {hubs.map((hub, index) => {
        const collapsed = prefs.collapsedHubIds.includes(hub.id);
        const agg = hubAggregate(hub, unread, mentions, muted);
        // The insertion line, hidden at the two slots that would drop the
        // hub right back where it is.
        const indicatorAt = (slot: number) =>
          drag !== null &&
          drag.overIndex === slot &&
          slot !== drag.fromIndex &&
          slot !== drag.fromIndex + 1;
        return (
          <Fragment key={hub.id}>
            {indicatorAt(index) && (
              <div className="mx-1 mt-3 h-0.5 rounded bg-accent-500" />
            )}
            <div
              ref={(el) => {
                if (el) blockRefs.current.set(hub.id, el);
                else blockRefs.current.delete(hub.id);
              }}
              className={`${canCreate || index !== 0 ? "mt-3" : ""} ${
                drag?.hubId === hub.id ? "opacity-50" : ""
              }`}
            >
            <div
              className="flex items-center gap-1"
              onPointerDown={(event) => beginPress(hub.id, index, event)}
            >
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
                onClick={() => {
                  // A drag that just ended must not also open the panel.
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onOpenHub(hub.id);
                }}
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
            {index === hubs.length - 1 && indicatorAt(hubs.length) && (
              <div className="mx-1 mt-3 h-0.5 rounded bg-accent-500" />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
