// Contacts: who you know, who is waiting on you, and who you have blocked.
//
// The same full-screen shape as Settings, for the same reason -- no router,
// and a phone wants a page here anyway.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  acceptFriend,
  blockUser,
  createConversation,
  fetchFriends,
  lookupUser,
  removeFriend,
  requestFriend,
  unblockUser,
  type Friend,
  type FriendLists,
} from "../api/client";
import { sync } from "../sync/engine";

const buttonClass =
  "shrink-0 rounded-md px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800";

function Person({
  person,
  detail,
  children,
}: {
  person: Friend;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className="block truncate text-sm text-neutral-900 dark:text-neutral-100">
          {person.displayName}
        </span>
        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
          @{person.username}
          {detail ? ` · ${detail}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 gap-1">{children}</span>
    </li>
  );
}

export function Friends({
  onClose,
  onOpenConversation,
}: {
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [lists, setLists] = useState<FriendLists | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLists(await fetchFriends());
    } catch {
      setError("Could not load your contacts.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(work: () => Promise<void>, success?: string) {
    setError(null);
    try {
      await work();
      await reload();
      if (success) setNote(success);
    } catch (caught) {
      setNote(null);
      setError(
        caught instanceof ApiError ? caught.message : "That did not work.",
      );
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const name = username.trim();
    if (name.length === 0) return;

    setBusy(true);
    setNote(null);
    setError(null);

    try {
      // Two steps because the API takes an id and only lookup turns a name
      // into one -- the same exact-match lookup that keeps this from being a
      // searchable directory. A blocked account is simply not found, which is
      // what makes a block undetectable from this side.
      const user = await lookupUser(name);
      const result = await requestFriend(user.id);

      setUsername("");
      setNote(
        result.mutual
          ? `You and ${user.displayName} are now contacts.`
          : `Request sent to ${user.displayName}.`,
      );
      await reload();
    } catch (caught) {
      setNote(null);
      setError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with that username."
          : caught instanceof ApiError
            ? caught.message
            : "Could not send that request.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function message(person: Friend) {
    setError(null);
    try {
      // Find-or-create, so this reopens an existing thread rather than
      // starting a second one with the same person.
      const conversation = await createConversation({
        kind: "direct",
        memberUserIds: [person.userId],
      });
      sync.invalidateConversations();
      onOpenConversation(conversation.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not open that chat.",
      );
    }
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <button
          onClick={onClose}
          aria-label="Back"
          className="-ml-2 rounded px-2 py-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ←
        </button>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Contacts
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <form onSubmit={add} className="flex gap-2 py-4">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Add by username"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <button
            type="submit"
            disabled={busy || username.trim().length === 0}
            className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "…" : "Add"}
          </button>
        </form>

        {(note || error) && (
          <p
            className={`pb-3 text-xs ${
              error
                ? "text-red-600 dark:text-red-400"
                : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {error ?? note}
          </p>
        )}

        {lists === null ? (
          <p className="text-xs text-neutral-500">Loading…</p>
        ) : (
          <>
            {lists.incoming.length > 0 && (
              <Group title={`Requests (${lists.incoming.length})`}>
                {lists.incoming.map((person) => (
                  <Person key={person.userId} person={person}>
                    <button
                      className={buttonClass}
                      onClick={() =>
                        void act(
                          () => acceptFriend(person.userId),
                          `You and ${person.displayName} are now contacts.`,
                        )
                      }
                    >
                      Accept
                    </button>
                    <button
                      className={buttonClass}
                      onClick={() => void act(() => removeFriend(person.userId))}
                    >
                      Decline
                    </button>
                  </Person>
                ))}
              </Group>
            )}

            <Group title="Contacts">
              {lists.friends.length === 0 ? (
                <p className="py-2 text-xs text-neutral-500 dark:text-neutral-400">
                  Nobody yet. Add somebody by their username above.
                </p>
              ) : (
                lists.friends.map((person) => (
                  <Person key={person.userId} person={person}>
                    <button className={buttonClass} onClick={() => void message(person)}>
                      Message
                    </button>
                    <button
                      className={buttonClass}
                      onClick={() => void act(() => removeFriend(person.userId))}
                    >
                      Remove
                    </button>
                    <button
                      className={`${buttonClass} text-red-600 dark:text-red-400`}
                      onClick={() =>
                        void act(
                          () => blockUser(person.userId),
                          `${person.displayName} is blocked.`,
                        )
                      }
                    >
                      Block
                    </button>
                  </Person>
                ))
              )}
            </Group>

            {lists.outgoing.length > 0 && (
              <Group title="Sent">
                {lists.outgoing.map((person) => (
                  <Person key={person.userId} person={person} detail="waiting">
                    <button
                      className={buttonClass}
                      onClick={() => void act(() => removeFriend(person.userId))}
                    >
                      Cancel
                    </button>
                  </Person>
                ))}
              </Group>
            )}

            {lists.blocked.length > 0 && (
              <Group
                title="Blocked"
                description="They cannot message you, find you, or tell that you blocked them."
              >
                {lists.blocked.map((person) => (
                  <Person key={person.userId} person={person}>
                    <button
                      className={buttonClass}
                      onClick={() =>
                        void act(
                          () => unblockUser(person.userId),
                          `${person.displayName} is unblocked. You are not contacts any more.`,
                        )
                      }
                    >
                      Unblock
                    </button>
                  </Person>
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-neutral-200 py-3 dark:border-neutral-800">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h2>
      {description && (
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      )}
      <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
        {children}
      </ul>
    </section>
  );
}
