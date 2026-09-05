// The folded hubs section's rail: every hub as a picture with its name
// beneath, in one horizontally scrolling row (2026-09-05).
//
// This is what "roll up the hubs" means now. The fold used to reduce three
// hubs' worth of channels to one header row, which saved the space and lost
// the hubs: every one of them was a tap into the fold away. A row of icons
// keeps them in sight at a fifth of the height, keeps their unread roll-up
// on each, and a tap on one shows just that hub's channels beneath the row
// -- never the whole vertical list, which stays behind the section's own
// chevron.
//
// It scrolls natively (`overflow-x-auto`, snap points), so a finger swipes
// it and a trackpad scrolls it; a mouse wheel needs shift, and with a
// 288px sidebar that is four or five hubs in view before it matters. The
// scrollbar is hidden by class (index.css): permanent chrome under five
// icons reads as a defect.
//
// Reordering is the same hold-to-lift mechanism as the vertical list
// (useReorder, axis x), and the drop indicator is a vertical bar between
// cells rather than the list's horizontal line.

import { Fragment } from "react";
import type { HubSummary } from "../../api/types";
import { Badge } from "../kit";
import { HubAvatar } from "../HubAvatar";
import { hubAggregate } from "./channels";
import { indicatorSlot } from "./reorder";
import { useReorder } from "./useReorder";

export function HubRail({
  hubs,
  unread,
  mentions,
  muted,
  openHubId,
  onToggleHub,
  onReorder,
}: {
  hubs: HubSummary[];
  unread: Map<string, number>;
  mentions: Set<string>;
  muted: Set<string>;
  /** The hub whose channels are showing beneath the rail, if any. */
  openHubId: string | null;
  onToggleHub: (hubId: string) => void;
  onReorder: (next: HubSummary[]) => void;
}) {
  const { drag, holding, itemProps } = useReorder({
    items: hubs,
    axis: "x",
    onReorder,
  });
  const slot = drag ? indicatorSlot(drag.fromIndex, drag.overIndex) : null;

  return (
    <div
      role="list"
      aria-label="Hubs"
      className="scrollbar-none -mx-1 flex snap-x snap-proximity gap-1 overflow-x-auto px-1 pb-1 pt-1"
    >
      {hubs.map((hub, index) => {
        const agg = hubAggregate(hub, unread, mentions, muted);
        const open = hub.id === openHubId;
        const lifted = drag?.id === hub.id;
        return (
          <Fragment key={hub.id}>
            {slot === index && <DropBar />}
            <div
              {...itemProps(hub.id, index)}
              role="listitem"
              // Lifted: follows the pointer along the rail and sits above
              // its neighbours. Held (not yet lifted): a slight press-in,
              // the only feedback a finger gets before the lift on iOS.
              className={`relative shrink-0 snap-start transition-transform ${
                lifted ? "z-10 !transition-none" : holding === hub.id ? "scale-95" : ""
              }`}
              style={
                lifted
                  ? { transform: `translateX(${drag.offset}px) scale(1.06)` }
                  : undefined
              }
            >
              <button
                type="button"
                onClick={() => onToggleHub(hub.id)}
                aria-pressed={open}
                aria-label={`${hub.name}${
                  agg.count > 0 ? `, ${agg.count} unread` : ""
                }${agg.mentioned ? ", mentions you" : ""}`}
                className="flex w-[4.5rem] flex-col items-center gap-1 rounded-lg px-0.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <span
                  className={`relative rounded-xl ${
                    open
                      ? "ring-2 ring-accent-600 ring-offset-2 dark:ring-offset-neutral-900"
                      : ""
                  } ${lifted ? "shadow-lg" : ""}`}
                >
                  <HubAvatar hub={hub} size="lg" />
                  {agg.mentioned && (
                    <span
                      aria-hidden="true"
                      className="absolute -left-1 -top-1 rounded-full bg-white px-1 text-xs font-bold leading-4 text-accent-600 dark:bg-neutral-900 dark:text-accent-400"
                    >
                      @
                    </span>
                  )}
                  <Badge
                    count={agg.count}
                    className="absolute -right-1 -top-1 ring-2 ring-white dark:ring-neutral-900"
                  />
                </span>
                {/* Two lines, then clipped: one truncated line turned
                    "Regress Public Hub" and "Regress Private Hub" into the
                    same "Regress…", which is the one thing a label under
                    an icon must not do. */}
                <span
                  className={`line-clamp-2 w-full break-words text-center text-[0.6875rem] leading-tight ${
                    open || agg.count > 0
                      ? "font-semibold text-neutral-900 dark:text-neutral-100"
                      : "text-neutral-600 dark:text-neutral-300"
                  }`}
                >
                  {hub.name}
                </span>
              </button>
            </div>
            {index === hubs.length - 1 && slot === hubs.length && <DropBar />}
          </Fragment>
        );
      })}
    </div>
  );
}

function DropBar() {
  return <div className="my-2 w-0.5 shrink-0 rounded bg-accent-500" />;
}
