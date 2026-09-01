// Rename and add-members, in one full-screen panel -- the two things only a
// group can do. Extracted from Chat.tsx as part of breaking that file up;
// see GroupDetails' own comment below for why it is shaped this way.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ContactCheckboxRow } from "./ContactRow";
import {
  ApiError,
  addMembers,
  fetchFriends,
  leaveConversation,
  lookupUser,
  removeMember,
  renameConversation,
  type Friend,
} from "../api/client";
import { sync } from "../sync/engine";
import { mlsEnabled, mlsSync } from "../sync/mls";
import type { StoredConversation } from "../store/types";
import {
  Avatar,
  Button,
  ErrorText,
  Input,
  Panel,
  PanelSection,
  handleInputProps,
} from "./kit";

/**
 * Rename and add-members, in one panel -- the two things only a group can do.
 * Same full-screen shape as Friends and Settings, for the same reason.
 */
export function GroupDetails({
  conversation,
  selfUserId,
  onClose,
}: {
  conversation: StoredConversation;
  selfUserId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(conversation.title ?? "");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const [contacts, setContacts] = useState<Friend[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [username, setUsername] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Default OFF: the adder is making this call on behalf of every other
  // member's messages, not only their own.
  const [shareHistory, setShareHistory] = useState(false);

  // Which member is currently being removed, if any -- disables just that
  // row's button rather than the whole panel.
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const memberIds = useMemo(
    () => new Set(conversation.members.map((m) => m.userId)),
    [conversation.members],
  );

  useEffect(() => {
    void fetchFriends()
      .then((lists) => setContacts(lists.friends))
      .catch(() => setContacts([]));
  }, []);

  async function saveTitle(event: FormEvent) {
    event.preventDefault();
    setTitleBusy(true);
    setTitleError(null);
    try {
      await renameConversation({
        conversationId: conversation.id,
        title: title.trim() || null,
      });
      // The list is refreshed on a timer, same as after creating a
      // conversation -- nudge it rather than waiting up to 30 seconds.
      sync.invalidateConversations();
    } catch (caught) {
      setTitleError(
        caught instanceof ApiError ? caught.message : "Could not rename the group.",
      );
    } finally {
      setTitleBusy(false);
    }
  }

  function toggle(userId: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function addPicked(event: FormEvent) {
    event.preventDefault();
    setAddBusy(true);
    setAddError(null);

    try {
      const names = [
        ...new Set(
          username
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];
      const typed = await Promise.all(names.map((name) => lookupUser(name)));

      const newIds = [
        ...new Set([...picked, ...typed.map((user) => user.id)]),
      ].filter((id) => id !== selfUserId && !memberIds.has(id));

      if (newIds.length === 0) return;

      await addMembers({
        conversationId: conversation.id,
        memberUserIds: newIds,
        shareHistory,
      });
      if (shareHistory && mlsEnabled()) {
        // The membership row is in; hand the new members the history-key
        // generations this device holds. Additive and idempotent, so a
        // failure here is retryable by re-adding with the box checked --
        // and the notice line records the *choice* either way.
        try {
          await mlsSync.shareHistory(conversation.id, newIds);
        } catch (caught) {
          console.warn("history share failed", caught);
        }
      }
      // Membership changed: nudge the conversation list now, and run the
      // MLS sweep now rather than up to 30 seconds later -- it issues the
      // Add/welcome and rotates the history key for the new roster.
      mlsSync.invalidate();
      sync.invalidateConversations();
      setPicked(new Set());
      setUsername("");
    } catch (caught) {
      setAddError(
        caught instanceof ApiError && caught.code === "UNKNOWN_USER"
          ? "No account with one of those usernames."
          : caught instanceof ApiError
            ? caught.message
            : "Could not add them.",
      );
    } finally {
      setAddBusy(false);
    }
  }

  async function removeOne(userId: string): Promise<void> {
    setRemovingUserId(userId);
    setRemoveError(null);
    try {
      await removeMember({ conversationId: conversation.id, userId });
      // Same nudge as addMembers: membership changed, so run the MLS sweep
      // now (it issues the Remove and rotates the history key) rather than
      // waiting for its own cadence, and refresh the list now too.
      mlsSync.invalidate();
      sync.invalidateConversations();
    } catch (caught) {
      setRemoveError(
        caught instanceof ApiError ? caught.message : "Could not remove them.",
      );
    } finally {
      setRemovingUserId(null);
    }
  }

  async function doLeave(): Promise<void> {
    setLeaveBusy(true);
    setLeaveError(null);
    try {
      await leaveConversation(conversation.id);
      mlsSync.invalidate();
      sync.invalidateConversations();
      // Nothing left to show a member of a group they just left.
      onClose();
    } catch (caught) {
      setLeaveError(
        caught instanceof ApiError ? caught.message : "Could not leave the group.",
      );
      setLeaveBusy(false);
    }
  }

  // Contacts not already in the group and not yourself -- the only people
  // this form can usefully add.
  const addable = (contacts ?? []).filter(
    (contact) => !memberIds.has(contact.userId),
  );

  return (
    <Panel title="Group details" onClose={onClose}>
      <div>
        <PanelSection title="Name">
          <form onSubmit={saveTitle} className="flex gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Group name"
              maxLength={100}
            />
            <Button type="submit" size="sm" loading={titleBusy} className="shrink-0">
              Save
            </Button>
          </form>
          {titleError && <ErrorText className="mt-1">{titleError}</ErrorText>}
        </PanelSection>

        <PanelSection title={`Members (${conversation.members.length})`}>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {conversation.members.map((member) => (
              <li
                key={member.userId}
                className="flex items-center justify-between gap-2 py-2 text-sm text-neutral-900 dark:text-neutral-100"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar
                    size="sm"
                    name={member.displayName || member.username}
                    userId={member.userId}
                    hue={member.avatarHue}
                  />
                  <span className="truncate">
                    {member.displayName || member.username}
                    {member.displayName && (
                      <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        @{member.username}
                      </span>
                    )}
                    {member.userId === selfUserId && (
                      <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
                        (you)
                      </span>
                    )}
                  </span>
                </span>
                {member.userId !== selfUserId && (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => removeOne(member.userId)}
                    loading={removingUserId === member.userId}
                    className="shrink-0 hover:underline"
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {removeError && <ErrorText className="mt-1">{removeError}</ErrorText>}
        </PanelSection>

        <div className="border-b border-neutral-200 px-4 py-5 dark:border-neutral-800">
          <Button
            variant="danger"
            size="sm"
            onClick={doLeave}
            loading={leaveBusy}
            className="w-full"
          >
            Leave group
          </Button>
          {leaveError && <ErrorText className="mt-1">{leaveError}</ErrorText>}
        </div>

        <PanelSection title="Add people">
          <form onSubmit={addPicked} className="space-y-2">
            {addable.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                {addable.map((contact) => (
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
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Or add by username"
              {...handleInputProps}
              className="font-mono"
            />

            <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
              <input
                type="checkbox"
                checked={shareHistory}
                onChange={(e) => setShareHistory(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                Share previous messages
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  Everyone's earlier messages in this group, not only yours.
                  The notice line will say you did.
                </span>
              </span>
            </label>

            {addError && <ErrorText>{addError}</ErrorText>}

            <Button
              type="submit"
              size="sm"
              loading={addBusy}
              disabled={picked.size === 0 && username.trim().length === 0}
              className="w-full"
            >
              Add
            </Button>
          </form>
        </PanelSection>
      </div>
    </Panel>
  );
}
