// The sidebar's "start a conversation" form: pick contacts, or type
// usernames, and either opens or creates the thread.

import { useEffect, useState, type FormEvent } from "react";
import { ContactCheckboxRow } from "../ContactRow";
import {
  ApiError,
  createConversation,
  fetchFriends,
  lookupUser,
  type Friend,
} from "../../api/client";
import type { StoredSession } from "../../api/session";
import { sync } from "../../sync/engine";
import { Button, ErrorText, Input, handleInputProps } from "../kit";

/**
 * Username in, conversation out.
 *
 * Two calls, because `POST /conversations` takes ids and a person types names.
 * `GET /users/lookup` is the only thing that bridges them -- without it the
 * only ids a client ever holds are the ones already in its conversations,
 * which makes starting the first one impossible.
 */
export function NewConversation({
  session,
  onOpened,
}: {
  session: StoredSession;
  onOpened: (conversationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [contacts, setContacts] = useState<Friend[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded when the form opens rather than with the app. It is a handful of
  // rows, it is only needed here, and fetching it on every startup would be a
  // request per launch for a list most launches never look at.
  useEffect(() => {
    if (!open || contacts !== null) return;
    void fetchFriends()
      .then((lists) => setContacts(lists.friends))
      .catch(() => setContacts([]));
  }, [open, contacts]);

  function toggle(userId: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function reset(): void {
    setUsername("");
    setPicked(new Set());
    setError(null);
    setOpen(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      // Comma or space separated, so a group is typed the same way a single
      // name is rather than behind a mode switch. Typing is still here
      // alongside the picker, because somebody who is not a contact yet has to
      // be reachable without being added first.
      const names = [
        ...new Set(
          username
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];

      const typed = await Promise.all(names.map((name) => lookupUser(name)));

      if (typed.some((user) => user.id === session.user.id)) {
        setError("You are in every conversation you start; leave yourself out.");
        return;
      }

      // A Set, because picking somebody *and* typing their name is an easy
      // thing to do and should not send the server a duplicate member.
      const memberUserIds = [
        ...new Set([...picked, ...typed.map((user) => user.id)]),
      ];

      if (memberUserIds.length === 0) return;

      // Two people is a direct conversation and is find-or-create, so naming
      // somebody you already talk to reopens that thread rather than splitting
      // the history in two. Three or more is a group, and groups always
      // create: two groups with the same people are legitimately different
      // groups, which is why the server does not deduplicate them.
      const conversation = await createConversation({
        kind: memberUserIds.length === 1 ? "direct" : "group",
        memberUserIds,
      });

      // The list is refreshed on a timer, so nudge it rather than waiting.
      sync.invalidateConversations();
      onOpened(conversation.id);
      reset();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with one of those usernames."
          : caught instanceof ApiError
            ? caught.message
            : "Cannot reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="w-full"
      >
        New conversation
      </Button>
    );
  }

  const canSend = picked.size > 0 || username.trim().length > 0;

  return (
    <form onSubmit={submit} className="space-y-2">
      {contacts !== null && contacts.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          {contacts.map((contact) => (
            <ContactCheckboxRow
              key={contact.userId}
              contact={contact}
              checked={picked.has(contact.userId)}
              onToggle={() => toggle(contact.userId)}
            />
          ))}
        </div>
      )}

      <Input
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={
          contacts !== null && contacts.length > 0
            ? "Or add by username"
            : "username, or several for a group"
        }
        {...handleInputProps}
        // An address gets typed here, so it renders as one -- the same
        // monospace the @handle wears everywhere it is displayed.
        className="font-mono"
      />

      {picked.size > 1 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {picked.size} people — this will start a group.
        </p>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !canSend}
          className="flex-1"
        >
          {busy ? "…" : "Start"}
        </Button>
        <Button variant="ghost" size="sm" onClick={reset} className="px-3 py-1.5">
          Cancel
        </Button>
      </div>
    </form>
  );
}
