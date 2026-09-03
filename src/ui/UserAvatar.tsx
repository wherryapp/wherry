// A person's avatar, with their profile picture when they have one.
//
// The kit's Avatar takes an already-resolved `src` and does no fetching --
// it knows nothing about the API and should keep knowing nothing. This is
// the app-layer wrapper that closes that gap: it holds the one hook call.
//
// It exists as a component rather than a hook call at each site because
// most of these are inside a `.map()` -- a member list, a friends list, a
// sidebar -- and a hook cannot be called in a loop. One component per row is
// the ordinary React answer, and it means adding pictures to a new list is
// swapping the element rather than restructuring the list.

import { Avatar } from "./kit";
import { useAvatarUrl } from "./hooks";

export function UserAvatar({
  userId,
  name,
  hue,
  avatarKey,
  size,
  className,
}: {
  userId: string;
  name: string;
  hue?: number | null;
  /** Null, undefined or a key with no bytes behind it all mean initials. */
  avatarKey?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const src = useAvatarUrl(userId, avatarKey);
  return (
    <Avatar
      userId={userId}
      name={name}
      hue={hue ?? null}
      src={src}
      {...(size ? { size } : {})}
      {...(className ? { className } : {})}
    />
  );
}
