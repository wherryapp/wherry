// Somebody's profile, as a layer over whatever is on screen.
//
// Opened from any surface that shows a person (ui/profile.ts's openProfile)
// and rendered once by Chat.tsx. Paints immediately from the hint the
// opener already had -- name, handle, colour are on every member row --
// and then fills in the two things only the server knows: how you stand
// with them, and (friends only, decided 2026-09-03) whether they are here.
//
// The visibility classes this had to settle (docs/roadmap.md's intake) came
// down to one field. Name, handle and colour were already disclosed to every
// co-member and every lookup, and the friendship row is your own. Presence
// is the only thing this reveals that a stranger could not already see, so
// presence is what being friends unlocks; the server withholds it otherwise
// and this renders no line at all rather than a misleading "offline".
//
// Actions are the contact operations Friends.tsx already has, reached from
// where the person actually is -- a group, a thread -- instead of a list
// you have to go and find them in. Destructive ones confirm.

import { useEffect, useState } from "react";
import {
  acceptFriend,
  ApiError,
  blockUser,
  createConversation,
  fetchProfile,
  removeFriend,
  requestFriend,
  unblockUser,
} from "../api/client";
import type { StoredSession } from "../api/session";
import type { UserProfile } from "../api/types";
import { sync } from "../sync/engine";
import { useAvatarUrl, useConversations } from "./hooks";
import {
  Avatar,
  ChatIcon,
  ErrorText,
  GearIcon,
  LoadingLine,
  PencilIcon,
  Popover,
  PopoverRow,
  TrashIcon,
  UsersIcon,
  useConfirm,
  XIcon,
} from "./kit";
import type { ProfileRequest } from "./profile";
import { statusLabel } from "./status";
import { StatusDot } from "./StatusDot";

export function ProfileCard({
  request,
  session,
  onClose,
  onOpenConversation,
  onOpenSettings,
}: {
  request: ProfileRequest;
  session: StoredSession;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const { conversations } = useConversations();

  const self = request.userId === session.user.id;

  async function load(): Promise<void> {
    try {
      setProfile(await fetchProfile(request.userId));
    } catch (caught) {
      // No such account, or one that blocked us -- the same 404 lookup
      // gives, and the card says the honest thing it can: nothing more.
      if (caught instanceof ApiError && caught.status === 404) setGone(true);
      else setError("Could not load this profile.");
    }
  }

  useEffect(() => {
    setProfile(null);
    setGone(false);
    setError(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.userId]);

  // What the opener knew, until (and unless) the fetch says otherwise.
  const displayName =
    profile?.user.displayName ?? request.hint?.displayName ?? "Someone";
  const username = profile?.user.username ?? request.hint?.username ?? null;
  const avatarHue = profile?.user.avatarHue ?? request.hint?.avatarHue ?? null;
  const avatarKey = profile?.user.avatarKey ?? request.hint?.avatarKey ?? null;
  const avatarUrl = useAvatarUrl(request.userId, avatarKey);

  // Shared conversations are counted locally: the list is already here, and
  // the server telling us would be a new disclosure for no new information.
  const shared = conversations.filter((conversation) =>
    conversation.members.some((member) => member.userId === request.userId),
  ).length;

  async function act(
    operation: () => Promise<unknown>,
    options: { confirm?: string; confirmLabel?: string } = {},
  ): Promise<void> {
    if (options.confirm) {
      const ok = await confirm({
        message: options.confirm,
        confirmLabel: options.confirmLabel ?? "Confirm",
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function message(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Find-or-create, the same call Friends.tsx makes: this reopens an
      // existing thread rather than starting a second one.
      const conversation = await createConversation({
        kind: "direct",
        memberUserIds: [request.userId],
      });
      sync.invalidateConversations();
      onOpenConversation(conversation.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not open that chat.");
      setBusy(false);
    }
  }

  const relationship = self ? "self" : profile?.relationship;

  let standing: string | null = null;
  if (relationship === "self") standing = "This is you.";
  else if (relationship === "friend") {
    standing = profile?.since
      ? `Friends since ${new Date(profile.since).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`
      : "Friends";
  } else if (relationship === "incoming") standing = "Wants to be your friend.";
  else if (relationship === "outgoing") standing = "Friend request sent.";
  else if (relationship === "blocked") standing = "You blocked this person.";
  else if (relationship === "none") standing = "Not friends.";

  return (
    <Popover anchor={request.anchor} onClose={onClose} label={`${displayName}'s profile`}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="relative shrink-0">
          <Avatar
            size="lg"
            name={displayName}
            userId={request.userId}
            hue={avatarHue}
            src={avatarUrl}
          />
          {profile?.presence && profile.presence !== "offline" && (
            <StatusDot status={profile.presence} size="md" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {displayName}
          </span>
          {username && (
            <span className="block truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
              @{username}
            </span>
          )}
          {/* Presence only when disclosed -- null is "not a friend", and no
              line at all is the honest rendering of that. The status
              message rides beside it under the same rule. */}
          {profile?.presence && (
            <span className="mt-0.5 block truncate text-xs text-neutral-600 dark:text-neutral-300">
              {statusLabel(profile.presence)}
              {profile.statusText && (
                <span className="text-neutral-500 dark:text-neutral-400">
                  {" · "}
                  {profile.statusText}
                </span>
              )}
            </span>
          )}
        </span>
      </div>

      {profile?.bio && (
        <p className="wrap-anywhere px-4 pb-3 text-sm text-neutral-700 dark:text-neutral-200">
          {profile.bio}
        </p>
      )}

      <div className="border-t border-neutral-200 px-4 py-2.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        {gone ? (
          <span>This account is not available.</span>
        ) : profile === null && !self ? (
          <LoadingLine />
        ) : (
          <>
            {standing && <span className="block">{standing}</span>}
            {!self && shared > 0 && (
              <span className="block">
                {shared === 1 ? "1 shared conversation" : `${shared} shared conversations`}
              </span>
            )}
          </>
        )}
      </div>

      {error && <ErrorText className="px-4 pb-2">{error}</ErrorText>}

      {!gone && (
        <div className="border-t border-neutral-200 py-1 dark:border-neutral-800">
          {self ? (
            <PopoverRow onClick={onOpenSettings} icon={<GearIcon />}>
              Edit in Settings
            </PopoverRow>
          ) : (
            <>
              {relationship !== "blocked" && (
                <PopoverRow onClick={() => void message()} icon={<ChatIcon />} disabled={busy}>
                  Message
                </PopoverRow>
              )}
              {relationship === "none" && (
                <PopoverRow
                  onClick={() => void act(() => requestFriend(request.userId))}
                  icon={<UsersIcon className="h-4 w-4" />}
                  disabled={busy}
                >
                  Add friend
                </PopoverRow>
              )}
              {relationship === "incoming" && (
                <>
                  <PopoverRow
                    onClick={() => void act(() => acceptFriend(request.userId))}
                    icon={<UsersIcon className="h-4 w-4" />}
                    disabled={busy}
                  >
                    Accept friend request
                  </PopoverRow>
                  <PopoverRow
                    onClick={() => void act(() => removeFriend(request.userId))}
                    icon={<XIcon />}
                    disabled={busy}
                  >
                    Decline
                  </PopoverRow>
                </>
              )}
              {relationship === "outgoing" && (
                <PopoverRow
                  onClick={() => void act(() => removeFriend(request.userId))}
                  icon={<XIcon />}
                  disabled={busy}
                >
                  Cancel friend request
                </PopoverRow>
              )}
              {relationship === "friend" && (
                <PopoverRow
                  onClick={() =>
                    void act(() => removeFriend(request.userId), {
                      confirm: `Remove ${displayName} from your friends?`,
                      confirmLabel: "Remove",
                    })
                  }
                  icon={<PencilIcon />}
                  disabled={busy}
                >
                  Remove friend
                </PopoverRow>
              )}
              {relationship === "blocked" ? (
                <PopoverRow
                  onClick={() => void act(() => unblockUser(request.userId))}
                  icon={<TrashIcon />}
                  disabled={busy}
                >
                  Unblock
                </PopoverRow>
              ) : (
                relationship !== undefined && (
                  <PopoverRow
                    onClick={() =>
                      void act(() => blockUser(request.userId), {
                        confirm: `Block ${displayName}? They will not be able to message you or find you, and will not be told.`,
                        confirmLabel: "Block",
                      })
                    }
                    icon={<TrashIcon />}
                    tone="danger"
                    disabled={busy}
                  >
                    Block
                  </PopoverRow>
                )
              )}
            </>
          )}
        </div>
      )}
      {confirmDialog}
    </Popover>
  );
}
