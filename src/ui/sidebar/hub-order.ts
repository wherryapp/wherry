// Moving a hub in the sidebar, now that the order belongs to the account
// (2026-09-05, migration 0030) rather than to this device.
//
// Optimistic on purpose: the sidebar draws the stored summary, and a drop
// that snapped back for the round trip and then jumped into place would
// read as the drag having failed. So the stored list is rewritten in the
// new order first, the server is told, and its answer -- the same list,
// authoritative -- replaces the optimistic copy. A failure leaves the
// optimistic order on screen only until the next refresh restores what the
// server holds, which is the honest outcome for a reorder the server never
// recorded. Other devices follow on their next hubs refresh: the server
// wakes them, and the refresh rides the conversation cadence, so within
// about thirty seconds -- the same path a rename or a new picture takes.

import { setHubOrder } from "../../api/client";
import type { HubSummary } from "../../api/types";
import { sync } from "../../sync/engine";

export async function reorderHubs(next: readonly HubSummary[]): Promise<void> {
  await sync.replaceHubs(
    next.map((hub, index) => ({ ...hub, sortOrder: index })),
  );
  try {
    const { hubs } = await setHubOrder(next.map((hub) => hub.id));
    await sync.replaceHubs(hubs);
  } catch {
    sync.invalidateConversations();
  }
}
