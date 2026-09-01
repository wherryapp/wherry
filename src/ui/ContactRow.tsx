// The contact-picker row with a checkbox, shared by every member-adding
// surface: the new-conversation picker, GroupDetails' add-people form, and
// HubDetails' -- extracted from Chat.tsx when the third user arrived,
// because three copies of one label is exactly the drift kit.tsx warns
// about, and kit itself stays free of API types on purpose.

import type { Friend } from "../api/client";
import { Avatar } from "./kit";

export function ContactCheckboxRow({
  contact,
  checked,
  onToggle,
}: {
  contact: Friend;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 shrink-0"
      />
      <Avatar
        size="sm"
        name={contact.displayName}
        userId={contact.userId}
        hue={contact.avatarHue}
      />
      <span className="min-w-0 truncate">
        {contact.displayName}
        <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
          @{contact.username}
        </span>
      </span>
    </label>
  );
}
