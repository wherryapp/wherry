// The composer's two draft shapes, and the excerpt they both quote from.
//
// Shared across three otherwise-unrelated files: the shell (Chat.tsx) owns
// the state, the timeline (Timeline.tsx) starts a draft from a Reply/Edit
// action, and the composer (Composer.tsx) renders and consumes it. None of
// those three should import from one another, so this tiny file is the
// common home instead -- extracted here (rather than folded into
// Timeline.tsx) because PinsPanel needs `excerptOf` too, and PinsPanel moved
// out of Chat.tsx before Timeline did.

import { displayFileName } from "./file-policy";

/**
 * A reply being composed: what the composer bar shows, and what becomes the
 * payload's `replyTo` on send. The excerpt is copied here at reply time --
 * into the payload too, eventually -- because the target may not exist on a
 * receiving device (see ReplyContext in api/payload.ts). `senderName` is
 * display-only; payloads carry the id and let each reader resolve the name.
 */
export type ReplyDraft = {
  messageId: string;
  excerpt: string;
  senderUserId: string;
  senderName: string;
};

/**
 * An edit being composed: the composer becomes the edit surface, prefilled
 * with the message's current text -- the messengers people know converge on
 * this over an in-bubble editor, and it reuses the context-bar slot the
 * reply already fills. `text` is the effective current text (a prior edit
 * included), because editing an edited message starts from what it says now.
 */
export type EditDraft = {
  messageId: string;
  text: string;
};

/**
 * What stands in for a message's attachments where only a word fits: the
 * sidebar's preview line and a reply's quoted excerpt. "Photo" only when
 * every attachment is an image -- any file has been attachable since
 * 2026-09-02, and a PDF previewed as "Photo" is wrong, in a reply quote wrong
 * for everyone, since the excerpt is copied into the payload. A single file
 * says its own (sanitised) name; anything else is "File".
 */
export function attachmentWord(
  attachments: readonly { mediaType: string; name?: string }[],
): string {
  if (attachments.length === 0) return "";
  if (attachments.every((attachment) => attachment.mediaType.startsWith("image/"))) {
    return "Photo";
  }
  const only = attachments.length === 1 ? attachments[0] : undefined;
  const name = only?.name ? displayFileName(only.name).slice(0, 120) : "";
  return name || "File";
}

/** The quoted line a reply shows: the text, or what stands in for it. */
export function excerptOf(content: {
  text: string;
  attachments: readonly { mediaType: string; name?: string }[];
}): string {
  return content.text.slice(0, 120) || attachmentWord(content.attachments);
}
