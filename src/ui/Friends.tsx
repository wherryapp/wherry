// Friends: who you know, who is waiting on you, and who you have blocked.
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
import { Avatar, Button, ErrorText, Input, Note, Panel, PanelSection } from "./kit";

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
      <span className="flex min-w-0 items-center gap-2">
        <Avatar size="sm" name={person.displayName} userId={person.userId} />
        <span className="min-w-0">
          <span className="block truncate text-sm text-neutral-900 dark:text-neutral-100">
            {person.displayName}
          </span>
          <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
            @{person.username}
            {detail ? ` · ${detail}` : ""}
          </span>
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
      setError("Could not load your friends.");
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
          ? `You and ${user.displayName} are now friends.`
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
    <Panel title="Friends" onClose={onClose}>
      <div>
        <form onSubmit={add} className="flex gap-2 px-4 py-4">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Add by username"
          />
          <Button
            type="submit"
            size="sm"
            loading={busy}
            disabled={username.trim().length === 0}
            className="shrink-0"
          >
            Add
          </Button>
        </form>

        {(note || error) &&
          (error ? (
            <ErrorText className="px-4 pb-3">{error}</ErrorText>
          ) : (
            <Note className="px-4 pb-3">{note}</Note>
          ))}

        {lists === null ? (
          <p className="px-4 text-xs text-neutral-500">Loading…</p>
        ) : (
          <>
            {lists.incoming.length > 0 && (
              <PanelSection title={`Requests (${lists.incoming.length})`}>
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {lists.incoming.map((person) => (
                    <Person key={person.userId} person={person}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() =>
                          void act(
                            () => acceptFriend(person.userId),
                            `You and ${person.displayName} are now friends.`,
                          )
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() => void act(() => removeFriend(person.userId))}
                      >
                        Decline
                      </Button>
                    </Person>
                  ))}
                </ul>
              </PanelSection>
            )}

            <PanelSection title={`Friends (${lists.friends.length})`}>
              {lists.friends.length === 0 ? (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Nobody yet. Add somebody by their username above.
                </p>
              ) : (
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {lists.friends.map((person) => (
                    <Person key={person.userId} person={person}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() => void message(person)}
                      >
                        Message
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() => void act(() => removeFriend(person.userId))}
                      >
                        Remove
                      </Button>
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        className="shrink-0 px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        onClick={() =>
                          void act(
                            () => blockUser(person.userId),
                            `${person.displayName} is blocked.`,
                          )
                        }
                      >
                        Block
                      </Button>
                    </Person>
                  ))}
                </ul>
              )}
            </PanelSection>

            {lists.outgoing.length > 0 && (
              <PanelSection title="Sent">
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {lists.outgoing.map((person) => (
                    <Person key={person.userId} person={person} detail="waiting">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() => void act(() => removeFriend(person.userId))}
                      >
                        Cancel
                      </Button>
                    </Person>
                  ))}
                </ul>
              </PanelSection>
            )}

            {lists.blocked.length > 0 && (
              <PanelSection
                title="Blocked"
                description="They cannot message you, find you, or tell that you blocked them."
              >
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {lists.blocked.map((person) => (
                    <Person key={person.userId} person={person}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 py-1"
                        onClick={() =>
                          void act(
                            () => unblockUser(person.userId),
                            `${person.displayName} is unblocked. You are not friends any more.`,
                          )
                        }
                      >
                        Unblock
                      </Button>
                    </Person>
                  ))}
                </ul>
              </PanelSection>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
