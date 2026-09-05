// A hub's avatar, with its picture when it has one -- UserAvatar for hubs.
//
// The same reasons that one exists: kit's Avatar takes a resolved `src` and
// does no fetching, and most hub avatars are drawn inside a `.map()` (the
// sidebar list, the folded rail), where a hook cannot be called. The
// rounded-square shape is what marks a place rather than a person, and it
// is decided here, once, so every surface that draws a hub agrees.

import type { HubSummary } from "../api/types";
import { Avatar } from "./kit";
import { useHubAvatarUrl } from "./hooks";

export function HubAvatar({
  hub,
  size,
  className,
}: {
  /** The summary's fields are enough; a HubDetail satisfies it too. */
  hub: Pick<HubSummary, "id" | "name" | "avatarHue" | "avatarKey">;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const src = useHubAvatarUrl(hub.id, hub.avatarKey);
  return (
    <Avatar
      // The hub id seeds the derived colour, so the identity survives
      // renames -- the identicon tier every hub had before pictures.
      userId={hub.id}
      name={hub.name}
      hue={hub.avatarHue}
      src={src}
      shape="rounded"
      {...(size ? { size } : {})}
      {...(className ? { className } : {})}
    />
  );
}
