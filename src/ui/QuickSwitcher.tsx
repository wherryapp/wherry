// The Ctrl/Cmd+K jump dialog: type a few letters, land in a conversation.
// Everything it searches the client already holds locally -- conversation
// titles and the hub summaries -- so this is a filter over memory, never a
// server call, and deliberately not the directory `/users/lookup` refuses
// to be.

import { useMemo, useState } from "react";
import type { HubSummary } from "../api/types";
import type { StoredConversation } from "../store/types";
import { avatarSeed, conversationTitle } from "./format";
import { Avatar, Input } from "./kit";

type Entry = {
  id: string;
  label: string;
  /** The hub name, for channel rows; null for DMs and groups. */
  sub: string | null;
  isChannel: boolean;
  /** The same seed the sidebar row uses, so the colours agree. */
  seed: string;
};

export function QuickSwitcher({
  conversations,
  hubs,
  selfId,
  onPick,
  onClose,
}: {
  conversations: readonly StoredConversation[];
  hubs: readonly HubSummary[];
  selfId: string;
  onPick: (conversationId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const entries = useMemo<Entry[]>(() => {
    const channelIdsFromHubs = new Set(
      hubs.flatMap((hub) => hub.channels.map((channel) => channel.id)),
    );
    const direct: Entry[] = conversations
      .filter((c) => c.kind !== "channel")
      .map((c) => ({
        id: c.id,
        label: conversationTitle(c, selfId),
        sub: null,
        isChannel: false,
        seed: avatarSeed(c, selfId),
      }));
    const channels: Entry[] = hubs.flatMap((hub) =>
      hub.channels.map((channel) => ({
        id: channel.id,
        label: `#${channel.title ?? "channel"}`,
        sub: hub.name,
        isChannel: true,
        seed: channel.id,
      })),
    );
    // A channel row whose hub summary is missing (the flag off, a stale
    // store) still deserves a row rather than vanishing from the switcher.
    const orphans: Entry[] = conversations
      .filter((c) => c.kind === "channel" && !channelIdsFromHubs.has(c.id))
      .map((c) => ({
        id: c.id,
        label: `#${c.title ?? "channel"}`,
        sub: null,
        isChannel: true,
        seed: c.id,
      }));
    return [...direct, ...channels, ...orphans];
  }, [conversations, hubs, selfId]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const hit = needle
      ? entries.filter(
          (entry) =>
            entry.label.toLowerCase().includes(needle) ||
            (entry.sub?.toLowerCase().includes(needle) ?? false),
        )
      : entries;
    return hit.slice(0, 10);
  }, [entries, needle]);

  const clampedActive = Math.min(active, Math.max(matches.length - 1, 0));

  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    onPick(entry.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 p-4 pt-24"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to conversation"
        onClick={(event) => event.stopPropagation()}
        className="h-fit w-full max-w-md rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
      >
        <Input
          autoFocus
          value={query}
          placeholder="Jump to…"
          aria-label="Jump to conversation"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(matches[clampedActive]);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <ul role="listbox" aria-label="Matches" className="mt-1">
          {matches.length === 0 && (
            <li className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400">
              Nothing matches.
            </li>
          )}
          {matches.map((entry, index) => (
            <li key={entry.id} role="option" aria-selected={index === clampedActive}>
              <button
                onClick={() => pick(entry)}
                onPointerEnter={() => setActive(index)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                  index === clampedActive
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : ""
                }`}
              >
                {entry.isChannel ? (
                  <span className="w-6 shrink-0 text-center text-neutral-400 dark:text-neutral-500">
                    #
                  </span>
                ) : (
                  <Avatar size="sm" name={entry.label} userId={entry.seed} />
                )}
                <span className="min-w-0 flex-1 truncate text-neutral-900 dark:text-neutral-100">
                  {entry.label.replace(/^#/, "")}
                </span>
                {entry.sub && (
                  <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                    {entry.sub}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
