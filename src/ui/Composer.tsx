// The message composer -- extracted from Chat.tsx as part of breaking that
// file up.

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { encodeContent, encodeOp, type AttachmentRef } from "../api/payload";
import { prepareForUpload } from "./media";
import { ApiError, fetchAttachmentUsage, uploadAttachment } from "../api/client";
import { e2e } from "../crypto";
import { encryptBlob } from "../crypto/blob";
import { sync } from "../sync/engine";
import { type EditDraft, type ReplyDraft } from "./drafts";
import { ErrorText, IconButton, Note, PlusIcon, SendIcon, XIcon } from "./kit";

type Pending = {
  file: File;
  /** A local preview, so a photo appears the moment it is chosen. */
  url: string;
};

export function Composer({
  conversationId,
  publicChannel,
  members,
  slowmodeSeconds,
  reply,
  onClearReply,
  edit,
  onClearEdit,
}: {
  conversationId: string;
  /**
   * The other members, for @-mention autocomplete. Mentions ride the
   * payload additively (api/payload.ts) -- highlight everywhere, and in a
   * public channel the server reads them to push exactly the people named.
   */
  members: readonly { userId: string; name: string }[];
  /** Shown when set; the server enforces it (mods exempt, ops exempt). */
  slowmodeSeconds: number | null;
  /**
   * True in a public hub channel, where nothing is sealed: the message
   * payload goes up readable (protocol v4 -- sync/engine.ts's enqueue
   * decides that on its own from the stored conversation), and attachments
   * skip the blob seal here for the same honesty -- a key that rides inside
   * a readable payload protects nothing, so encrypting the blob would be
   * decoration pretending to be a property.
   */
  publicChannel: boolean;
  /** The reply being composed, owned by the shell so Timeline can set it. */
  reply: ReplyDraft | null;
  onClearReply: () => void;
  /** The edit being composed. The shell keeps this and `reply` exclusive. */
  edit: EditDraft | null;
  onClearEdit: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // How this field was last touched -- the same pointerType signal Bubble's
  // press handling uses, never the platform (see CLAUDE.md's sharp edge on
  // this, and the action bar's tap trigger it points at). A touch keyboard's
  // Return breaks the line; a hardware keyboard's Enter sends.
  const touchInput = useRef(false);

  // The @-token being typed at the caret, or null. Suggestion picks insert
  // "@Name " and remember name -> id here; at send time only the names still
  // present in the text become the payload's mentions, so deleting a name
  // un-mentions the person without any bookkeeping.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionsPicked = useRef(new Map<string, string>());
  useEffect(() => {
    mentionsPicked.current.clear();
    setMentionQuery(null);
  }, [conversationId]);

  const mentionMatches =
    mentionQuery === null
      ? []
      : members
          .filter((member) =>
            member.name.toLowerCase().startsWith(mentionQuery.toLowerCase()),
          )
          .slice(0, 5);

  function readMentionQuery(value: string, caret: number): void {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    setMentionQuery(match ? match[2]! : null);
  }

  function pickMention(member: { userId: string; name: string }): void {
    const el = textarea.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const replaced = before.replace(/@([^\s@]{0,30})$/, `@${member.name} `);
    mentionsPicked.current.set(member.name, member.userId);
    setText(replaced + after);
    setMentionQuery(null);
    el?.focus();
  }

  // Entering edit mode loads the message's current text over whatever was
  // being typed; leaving it (cancel or save, both of which clear `edit`
  // explicitly alongside the text) never runs this.
  useEffect(() => {
    if (edit) setText(edit.text);
  }, [edit]);

  // Grows the textarea with its content, up to the CSS max-height (then it
  // scrolls internally). Resetting to "auto" first is what lets it shrink
  // back down when text is deleted, not just grow.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const cancelEdit = (): void => {
    onClearEdit();
    setText("");
  };

  // Revoke preview URLs when they stop being used, or every photo somebody
  // picks and reconsiders is held in memory until the page is reloaded.
  useEffect(() => {
    return () => {
      for (const item of pending) URL.revokeObjectURL(item.url);
    };
  }, [pending]);

  function choose(event: FormEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];

    setPending((current) => [
      ...current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
    setError(null);

    // Cleared so picking the same file twice in a row still fires a change.
    input.value = "";
  }

  function remove(index: number): void {
    setPending((current) => {
      const item = current[index];
      if (item) URL.revokeObjectURL(item.url);
      return current.filter((_, i) => i !== index);
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const trimmed = text.trim();
    if (busy) return;

    // Edit mode: the send button saves the edit -- a silent op, aggregated
    // like any other, so the bubble re-renders from the outbox before the
    // round trip. Emptying the text is not a retraction; Delete is, and
    // conflating them would make a slip of the keyboard destructive.
    if (edit) {
      if (trimmed.length === 0) return;
      const target = edit.messageId;
      cancelEdit();
      await sync.enqueue(
        conversationId,
        encodeOp({ kind: "edit", target, text: trimmed }),
        { silent: true },
      );
      return;
    }

    if (trimmed.length === 0 && pending.length === 0) return;

    setBusy(true);
    setError(null);

    try {
      // Uploaded before the message is queued, because the payload has to
      // carry the ids. That makes an attachment send fail *before* anything is
      // in the outbox, which is the right way round: a queued message
      // referring to an upload that never happened would retry forever and
      // never work.
      const limits = await fetchAttachmentUsage();
      const attachments: AttachmentRef[] = [];

      for (const item of pending) {
        const prepared = await prepareForUpload(item.file, limits.maxBytes);

        if ("kind" in prepared) {
          setError(prepared.message);
          return;
        }

        // Under MLS the blob is sealed before it leaves this device, with a
        // fresh single-use key that rides inside the message payload -- the
        // one place already encrypted to exactly this conversation's
        // readers. See crypto/blob.ts. The passthrough build keeps
        // uploading plaintext, same as the messages around it -- and so
        // does a public channel, whose payload is readable by design (see
        // the publicChannel prop above): the ref then carries no key
        // fields, which every client already reads as the plaintext form.
        const sealed =
          e2e.handshake && !publicChannel
            ? await encryptBlob(prepared.bytes)
            : null;

        const uploaded = await uploadAttachment(
          conversationId,
          sealed ? sealed.ciphertext : prepared.bytes,
        );

        attachments.push({
          id: uploaded.id,
          mediaType: prepared.mediaType,
          byteSize: uploaded.byteSize,
          ...(prepared.width ? { width: prepared.width } : {}),
          ...(prepared.height ? { height: prepared.height } : {}),
          ...(sealed ? sealed.ref : {}),
        });
      }

      // Cleared before the await, so typing the next message is never blocked
      // on the network. The message is durable in the outbox by the time this
      // resolves, and the engine owns delivering it.
      setText("");
      for (const item of pending) URL.revokeObjectURL(item.url);
      setPending([]);
      if (reply) onClearReply();

      // Only the names still present count -- see the mention state above.
      const mentionIds = [...mentionsPicked.current]
        .filter(([name]) => trimmed.includes(`@${name}`))
        .map(([, userId]) => userId);
      mentionsPicked.current.clear();

      await sync.enqueue(
        conversationId,
        encodeContent({
          text: trimmed,
          attachments,
          ...(reply
            ? {
                replyTo: {
                  messageId: reply.messageId,
                  excerpt: reply.excerpt,
                  senderUserId: reply.senderUserId,
                },
              }
            : {}),
          ...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not send that. Check your connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-neutral-200 p-3 dark:border-neutral-800"
    >
      {pending.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto">
          {pending.map((item, index) => (
            <div key={item.url} className="relative shrink-0">
              <img
                src={item.url}
                alt=""
                className="h-16 w-16 rounded-md object-cover"
              />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label="Remove attachment"
                className="absolute -right-1 -top-1 rounded-full bg-neutral-900 px-1.5 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <ErrorText className="mb-2">{error}</ErrorText>}

      {/* The reply-context bar, in the slot the stage-3 comment below
          reserved for it. Height comes and goes with the reply -- that is a
          deliberate act by the user, not the ambient flicker the typing
          line's fixed height guards against. */}
      {reply && !edit && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-accent-400 bg-neutral-100 px-2 py-1 motion-safe:animate-fade-in dark:bg-neutral-800">
          <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            <span className="block font-medium">
              Replying to {reply.senderName}
            </span>
            <span className="block truncate">{reply.excerpt}</span>
          </span>
          <IconButton
            label="Cancel reply"
            onClick={onClearReply}
            className="shrink-0"
          >
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {edit && (
        <div className="mb-2 flex items-center gap-2 rounded-md border-l-2 border-accent-400 bg-neutral-100 px-2 py-1 motion-safe:animate-fade-in dark:bg-neutral-800">
          <span className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            <span className="block font-medium">Editing message</span>
            <span className="block truncate">{edit.text}</span>
          </span>
          <IconButton
            label="Cancel edit"
            onClick={cancelEdit}
            className="shrink-0"
          >
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {mentionMatches.length > 0 && !edit && (
        <div className="mb-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
          {mentionMatches.map((member) => (
            <button
              key={member.userId}
              type="button"
              onClick={() => pickMention(member)}
              className="block w-full px-3 py-1.5 text-left text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
            >
              @{member.name}
            </button>
          ))}
        </div>
      )}

      {/* A column on purpose: the row below keeps the reply-context bar's
          slot above it (filled by the block above since the wave's stage 3),
          and the row itself has room for a mic button beside the attach one
          for the same reason. */}
      <div className="flex items-center gap-2">
        {/* accept without capture. `capture` forces the camera and removes the
            photo library, which on a phone is where the photo somebody wants
            to send almost always already is. */}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          onInput={choose}
          className="hidden"
        />
        {/* No attach while editing: an edit replaces text only, and the
            target's attachments stay exactly as sent. */}
        {!edit && (
          <IconButton
            label="Attach a photo"
            onClick={() => fileInput.current?.click()}
            className="rounded-full"
          >
            <PlusIcon />
          </IconButton>
        )}
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            readMentionQuery(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            );
            // The typing signal, on input rather than on a timer. The
            // engine floors this to one frame per few seconds, so calling
            // it per keystroke is the debounce, not a violation of one.
            if (e.target.value.length > 0) sync.sendTyping(conversationId);
          }}
          onPointerDown={(e) => {
            touchInput.current = e.pointerType !== "mouse";
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
            // Touch keyboard: Return breaks the line, and only the send
            // button sends. Hardware keyboard: Enter sends (Shift+Enter
            // breaks the line, handled by the guard above).
            if (touchInput.current) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          placeholder="Message"
          className="max-h-32 min-w-0 flex-1 resize-none overflow-y-auto rounded-full border border-neutral-300 bg-white px-4 py-2 text-base outline-none transition-colors focus:border-neutral-500 md:text-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={busy || (text.trim().length === 0 && pending.length === 0)}
          // Deliberately not kit's Button: the round icon shape would have to
          // fight Button's rounded-md and padding with same-specificity
          // classes, which is the pointer-events bug's family. The palette is
          // kit primary's (bg-accent-600, hover 700) -- keep them in step.
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white transition hover:bg-accent-700 disabled:bg-neutral-300 motion-safe:active:scale-90 dark:disabled:bg-neutral-700"
        >
          <SendIcon className="h-4.5 w-4.5" />
        </button>
      </div>
      {slowmodeSeconds !== null && (
        <Note className="mt-1">
          Slowmode is on — one message every {slowmodeSeconds}s.
        </Note>
      )}
    </form>
  );
}
