// The message composer -- extracted from Chat.tsx as part of breaking that
// file up.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { encodeContent, encodeOp, type AttachmentRef } from "../api/payload";
import { prepareForUpload } from "./media";
import { ApiError, fetchAttachmentUsage, uploadAttachment } from "../api/client";
import { e2e } from "../crypto";
import { encryptBlob } from "../crypto/blob";
import { sync } from "../sync/engine";
import {
  acceptFiles,
  filesFromTransfer,
  intakeError,
  transferHasFiles,
} from "./attach-intake";
import { acceptAttribute, fileExtension, type FilePolicy } from "./file-policy";
import {
  transferRate,
  uploadPercent,
  uploadStatusLine,
  type UploadProgress,
} from "./upload-status";
import { setSendProgress, useSendProgress } from "./sending";
import { useFilePolicy } from "./hooks";
import { type EditDraft, type ReplyDraft } from "./drafts";
import {
  ErrorText,
  FileIcon,
  IconButton,
  Note,
  PlusIcon,
  SendIcon,
  SpinnerIcon,
  XIcon,
} from "./kit";
import { useCanDropFiles } from "./viewport";
import { WidgetBar } from "./widgets/WidgetBar";

type Pending = {
  file: File;
  /** A local preview, so a photo appears the moment it is chosen. */
  url: string;
};

/**
 * Why a paste or a drop is refused while an edit is being composed --
 * the same reason the attach button is hidden then.
 */
const EDIT_ATTACH_NOTE = "An edit changes the text; attachments stay as sent.";

export function Composer({
  conversationId,
  publicChannel,
  members,
  slowmodeSeconds,
  reply,
  onClearReply,
  edit,
  onClearEdit,
  gifsEnabled,
}: {
  conversationId: string;
  /**
   * The other members, for @-mention autocomplete. Mentions ride the
   * payload additively (api/payload.ts) -- highlight everywhere, and in a
   * public channel the server reads them to push exactly the people named.
   */
  members: readonly { userId: string; name: string; username: string }[];
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
  /**
   * Whether the GIF widget may be shown, from the shell's own useFeatures.
   *
   * A prop rather than a second useFeatures() call in here: that hook
   * fetches /account/settings on mount, and this component remounts on every
   * conversation switch. Chat.tsx already holds the answer.
   */
  gifsEnabled: boolean;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * Where this conversation's send has got to, or null when nothing is in
   * flight.
   *
   * Read from a module-level registry rather than held here, because leaving
   * the conversation unmounts this component and the upload carries on
   * without it -- see sending.ts. Held locally, coming back showed an empty
   * composer with no sign of the send, which reads as a cancellation.
   */
  const progress = useSendProgress(conversationId);
  const [error, setError] = useState<string | null>(null);
  // A drag carrying files is over the window. Raised by a real drag, never
  // by the capability query below -- see useCanDropFiles.
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // How this field was last touched -- the same pointerType signal Bubble's
  // press handling uses, never the platform (see CLAUDE.md's sharp edge on
  // this, and the action bar's tap trigger it points at). A touch keyboard's
  // Return breaks the line; a hardware keyboard's Enter sends.
  const touchInput = useRef(false);
  // When the field last lost focus, for keepKeyboardOpen below. `-Infinity`
  // rather than 0 so "never focused" is never mistaken for "blurred at the
  // epoch", which on a clock read as a number is 56 years ago and on a
  // performance timeline would be 0ms ago.
  const blurredAt = useRef(-Infinity);

  // Drag and drop is offered where a file can actually be dragged from --
  // a desktop browser, or the desktop app. Paste is not gated: a phone has
  // a clipboard, and an image on it pastes here like anywhere else.
  const canDrop = useCanDropFiles();
  const editing = edit !== null;
  // The operator's file rule, from GET /attachments/usage. Advisory -- the
  // server cannot see attachment types -- so this is what stops somebody
  // attaching the wrong thing, not what stops the wrong thing arriving.
  const filePolicy = useFilePolicy();

  // Which widgets the bar may show. A Set rather than a boolean per widget
  // so adding the second one does not change this component's shape --
  // WidgetBar.tsx owns the list, this owns whether each is allowed.
  const widgetsAvailable = useMemo(
    () => new Set(gifsEnabled ? ["gif"] : []),
    [gifsEnabled],
  );

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
          .filter(
            // Typing either the name or the handle finds the person --
            // somebody who knows the address should not have to know what
            // the display name currently is.
            (member) =>
              member.name
                .toLowerCase()
                .startsWith(mentionQuery.toLowerCase()) ||
              member.username
                .toLowerCase()
                .startsWith(mentionQuery.toLowerCase()),
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

  /**
   * The one way anything becomes a pending attachment.
   *
   * The picker, a paste and a drop all arrive here, so what may be
   * attached is decided once instead of three times -- and the two new
   * gestures inherit, for free, the `accept="image/*"` the picker got from
   * its markup. See attach-intake.ts for the rule itself.
   */
  const addFiles = useCallback((incoming: readonly File[]): void => {
    const intake = acceptFiles(incoming, filePolicy);

    // Null when nothing was refused, which is also how the previous error
    // gets cleared on a clean pick -- the behaviour choose() had.
    setError(intakeError(intake));
    if (intake.accepted.length === 0) return;

    setPending((current) => [
      ...current,
      ...intake.accepted.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, [filePolicy]);

  function choose(event: FormEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    addFiles(Array.from(input.files ?? []));

    // Cleared so picking the same file twice in a row still fires a change.
    input.value = "";
  }

  /**
   * An image on the clipboard becomes an attachment; anything else pastes
   * as it always did.
   *
   * Not gated on the drag-and-drop capability: pasting a screenshot is a
   * desktop habit, but a phone has a clipboard too, and an image copied out
   * of Photos pastes here the same way.
   */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return; // An ordinary text paste; leave it alone.

    if (editing) {
      // Deliberately *not* cancelled. An edit takes no attachments -- the
      // attach button is hidden for the same reason -- but a clipboard
      // carrying an image often carries text beside it, and that text is
      // still worth landing in the field somebody is editing.
      setError(EDIT_ATTACH_NOTE);
      return;
    }

    // Cancelled only now that the files are actually being taken. Copying
    // an image out of a web page usually puts the surrounding HTML on the
    // clipboard as well, and letting the default through would drop that
    // markup into the field as text beside the photo.
    event.preventDefault();
    addFiles(files);
  }

  // Drag and drop, listening on the window rather than on the composer.
  //
  // The composer is a strip a few dozen pixels tall at the bottom of the
  // screen, and nobody aims a dragged photo at it. The gesture people make
  // is "drop this on the conversation", so the window takes the drop and
  // the overlay says as much.
  //
  // A depth counter rather than a boolean, because dragenter and dragleave
  // fire for every element the pointer crosses on the way in: moving across
  // a message bubble raises a leave for the timeline and an enter for the
  // bubble, and a boolean flickers off on each one. Counting means only the
  // leave balancing the first enter puts the overlay away.
  useEffect(() => {
    if (!canDrop) return;

    let depth = 0;
    const clear = (): void => {
      depth = 0;
      setDragging(false);
    };

    const enter = (event: DragEvent): void => {
      if (!transferHasFiles(event.dataTransfer?.types)) return;
      depth += 1;
      if (!editing) setDragging(true);
    };

    const over = (event: DragEvent): void => {
      if (!transferHasFiles(event.dataTransfer?.types)) return;
      // drop-guard.ts has already cancelled this and set "none"; running
      // second, this is the half that says a drop here means something.
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = editing ? "none" : "copy";
      }
    };

    const leave = (event: DragEvent): void => {
      if (!transferHasFiles(event.dataTransfer?.types)) return;
      depth -= 1;
      // A null relatedTarget means the drag left the window altogether,
      // which is the case the counter alone misses: a drag that ends over
      // another application never balances its last enter, and the overlay
      // would sit there over an app nobody is dropping anything on.
      if (depth <= 0 || event.relatedTarget === null) clear();
    };

    const drop = (event: DragEvent): void => {
      const files = filesFromTransfer(event.dataTransfer);
      clear();
      if (files.length === 0) return;
      event.preventDefault();
      if (editing) {
        setError(EDIT_ATTACH_NOTE);
        return;
      }
      addFiles(files);
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);

    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      // Switching conversations mid-drag tears these down; the overlay must
      // not outlive the listener that would have cleared it.
      setDragging(false);
    };
  }, [addFiles, canDrop, editing]);

  function remove(index: number): void {
    setPending((current) => {
      const item = current[index];
      if (item) URL.revokeObjectURL(item.url);
      return current.filter((_, i) => i !== index);
    });
  }

  /**
   * Puts the caret back in the composer, so sending does not dismiss the
   * keyboard.
   *
   * Two mechanisms, because neither is sufficient alone. The send button
   * carries `onMouseDown={preventDefault}`, which is what stops the tap
   * from moving focus in the first place -- on iOS the blur happens during
   * the tap, long before this handler runs, so nothing done here could
   * bring the keyboard back if it had already gone. Where that holds, this
   * call is a no-op on an already-focused element.
   *
   * Where it does not hold, this is the recovery, and it has to happen
   * *synchronously inside the submit handler* -- iOS only opens the
   * keyboard for a `focus()` that is still inside the user gesture, so a
   * refocus after the awaits below would be silently ignored. That is why
   * it is the first thing submit does rather than the last.
   *
   * The blur window is what keeps an attachment-only send from summoning a
   * keyboard nobody asked for: no recent focus means the field was never in
   * use, and the tap was on the paperclip.
   */
  function keepKeyboardOpen(): void {
    const el = textarea.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (performance.now() - blurredAt.current > 700) return;
    el.focus({ preventScroll: true });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    keepKeyboardOpen();

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

    // Claimed before the limits are fetched, not after. That fetch is a
    // network round trip of its own, and leaving it uncovered would put a
    // silent gap right at the start -- exactly where somebody is deciding
    // whether the press registered.
    if (pending.length > 0) {
      setSendProgress(conversationId, {
        index: 0,
        total: pending.length,
        stage: "preparing",
        fraction: 0,
      });
    }

    try {
      // Uploaded before the message is queued, because the payload has to
      // carry the ids. That makes an attachment send fail *before* anything is
      // in the outbox, which is the right way round: a queued message
      // referring to an upload that never happened would retry forever and
      // never work.
      const limits = await fetchAttachmentUsage();
      const attachments: AttachmentRef[] = [];

      // Indexed rather than a for..of, because every stage below has to say
      // which attachment it is on.
      for (const [index, item] of pending.entries()) {
        const at = (
          stage: UploadProgress["stage"],
          fraction = 0,
          bytesPerSecond: number | null = null,
        ): void =>
          setSendProgress(conversationId, {
            index,
            total: pending.length,
            stage,
            fraction,
            bytesPerSecond,
          });

        at("preparing");
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
        at("sealing");
        const sealed =
          e2e.handshake && !publicChannel
            ? await encryptBlob(prepared.bytes)
            : null;

        at("uploading");
        // Timed from here rather than from the send as a whole: preparing and
        // sealing are CPU, not network, and averaging them into the rate
        // would report an uplink slower than it is -- the opposite of useful
        // when the number exists to tell those two apart.
        const startedAt = performance.now();
        const uploaded = await uploadAttachment(
          conversationId,
          sealed ? sealed.ciphertext : prepared.bytes,
          {
            onProgress: ({ loaded, total: bytes }) =>
              at(
                "uploading",
                bytes > 0 ? loaded / bytes : 0,
                transferRate(loaded, performance.now() - startedAt),
              ),
          },
        );

        attachments.push({
          id: uploaded.id,
          mediaType: prepared.mediaType,
          byteSize: uploaded.byteSize,
          ...(prepared.width ? { width: prepared.width } : {}),
          ...(prepared.height ? { height: prepared.height } : {}),
          // The filename, but only when the bytes are the ones that were
          // picked. `prepareForUpload` re-encodes photos to JPEG, and an
          // iPhone's "IMG_0001.HEIC" would then name a file that is no
          // longer a HEIC -- somebody downloads it, the extension lies, and
          // whatever opens it fails for a reason nothing on screen explains.
          // Re-encoded images lose the name instead, which costs nothing:
          // a photo renders inline and is never shown by name.
          ...(prepared.mediaType === item.file.type && item.file.name
            ? { name: item.file.name }
            : {}),
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
      setSendProgress(conversationId, null);
    }
  }

  return (
    <>
      {/* The drop target is the window (see the effect above), so the
          overlay covers it rather than sitting in the composer's own box --
          it is the answer to "where do I drop this?", and the honest answer
          is "anywhere". pointer-events-none is load-bearing: an element
          appearing under the pointer that took events would fire its own
          dragleave the instant it rendered, and the drop would land on it
          instead of on the listener that knows what to do with it. */}
      {dragging && !editing && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-neutral-950/40 p-6 motion-safe:animate-fade-in">
          <div className="rounded-xl border-2 border-dashed border-accent-500 bg-white px-6 py-5 text-center shadow-lg dark:bg-neutral-900">
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Drop to attach
            </p>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              {dropHint(filePolicy)}
            </p>
          </div>
        </div>
      )}

      <form
        onSubmit={submit}
        className="border-t border-neutral-200 p-3 dark:border-neutral-800"
      >
        {pending.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto">
            {pending.map((item, index) => (
              <div key={item.url} className="relative shrink-0">
                {item.file.type.startsWith("image/") ? (
                  <img
                    src={item.url}
                    alt=""
                    className="h-16 w-16 rounded-md object-cover"
                  />
                ) : (
                  // Not an <img> with a PDF in it, which is a broken-image
                  // icon and nothing else. The extension is the useful thing
                  // at this size -- the full name is unreadable in 64px and
                  // the person picked the file a second ago.
                  <span className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md bg-neutral-200 px-1 dark:bg-neutral-700">
                    <FileIcon className="h-5 w-5 text-neutral-500 dark:text-neutral-400" />
                    <span className="w-full truncate text-center text-[10px] uppercase text-neutral-600 dark:text-neutral-300">
                      {fileExtension(item.file.name) ?? "file"}
                    </span>
                  </span>
                )}
                {/* The progress of THIS attachment, over its own thumbnail.
                    On the one being worked on it is a bar; on the ones
                    already done it is a full bar, so a queue of three reads
                    as two finished and one moving rather than as one number
                    that keeps restarting. */}
                {progress && index <= progress.index && (
                  <span className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-neutral-900/40">
                    <span
                      className="block h-full rounded-full bg-white transition-[width] duration-150"
                      style={{
                        width:
                          index < progress.index
                            ? "100%"
                            : `${uploadPercent(progress.fraction)}%`,
                      }}
                    />
                  </span>
                )}
                {/* No removing mid-send: the loop is walking the array this
                    renders, and taking one out underneath it would upload a
                    file the message no longer refers to. */}
                {!busy && (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    aria-label="Remove attachment"
                    className="absolute -right-1 -top-1 rounded-full bg-neutral-900 px-1.5 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Said out loud, because the send button going grey is not an
            explanation. `aria-live` so it is announced rather than only
            drawn -- this is the one moment the app is unresponsive on
            purpose. */}
        {progress && (
          // The live region is the wrapper, not the Note: `Note` takes only
          // `children`/`className`/`boxed` and spreads nothing, so an
          // `aria-live` on it would be dropped -- silently, because
          // TypeScript does not check hyphenated JSX attributes.
          <div aria-live="polite" className="mb-2">
            <Note>{uploadStatusLine(progress)}</Note>
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
                {member.username !== member.name && (
                  // The display name is what people recognise; the handle is
                  // the address that disambiguates two Sams. What gets
                  // inserted stays the name -- mentions ride the payload as
                  // ids, not as parsed text.
                  <span className="ml-1.5 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                    @{member.username}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* A column on purpose: the row below keeps the reply-context bar's
            slot above it (filled by the block above since the wave's stage 3),
            and the row itself has room for a mic button beside the attach one
            for the same reason. */}
        <div className="flex items-center gap-2">
          {/* No `capture`: it forces the camera and removes the photo
              library, which on a phone is where the thing somebody wants to
              send almost always already is. Leaving it off keeps both -- the
              OS sheet offers "Take Photo" alongside the library.

              `accept` now comes from the policy, and is usually absent: a
              blocklist has no `accept` expression, since the attribute can
              only say what is permitted. That is exactly why the rule has to
              be applied to what comes back (attach-intake.ts) rather than
              trusted to the markup. */}
          <input
            ref={fileInput}
            type="file"
            {...(acceptAttribute(filePolicy)
              ? { accept: acceptAttribute(filePolicy) }
              : {})}
            multiple
            onInput={choose}
            className="hidden"
          />
          {/* No attach while editing: an edit replaces text only, and the
              target's attachments stay exactly as sent. */}
          {!edit && (
            <IconButton
              label="Attach a file"
              onClick={() => fileInput.current?.click()}
              className="rounded-full"
            >
              <PlusIcon />
            </IconButton>
          )}
          {/* Everything that puts content in a message without typing it.
              One widget today; the bar is what keeps the second one from
              being another bespoke button wired in here. Availability is
              decided here rather than in the bar, because a flag is this
              file's business and not the bar's. */}
          <WidgetBar
            available={widgetsAvailable}
            onAttach={addFiles}
            disabled={editing}
          />
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
            onPaste={paste}
            onPointerDown={(e) => {
              touchInput.current = e.pointerType !== "mouse";
            }}
            onBlur={() => {
              blurredAt.current = performance.now();
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
            // The whole reason sending used to close the keyboard: pressing
            // any other element moves focus out of the textarea, and on a
            // phone losing focus *is* the keyboard going away. Cancelling the
            // default of mousedown suppresses that focus change without
            // touching the click, which is the standard way a toolbar button
            // acts on a field it must not take the caret from. See
            // keepKeyboardOpen above for the half that handles browsers where
            // this does not hold.
            //
            // Cancelling mousedown does NOT cancel the click -- the click is
            // part of activation behaviour and is not conditioned on
            // mousedown's canceled flag, which is why editor toolbars have
            // used this for years. Confirmed here in Chromium (the message
            // sends and the caret stays in one test), reasoned from the spec
            // for WebKit. If sending ever stops working on a phone, this line
            // is the first thing to try removing -- keepKeyboardOpen alone
            // still covers most of the behaviour.
            onMouseDown={(e) => e.preventDefault()}
            disabled={busy || (text.trim().length === 0 && pending.length === 0)}
            // Deliberately not kit's Button: the round icon shape would have to
            // fight Button's rounded-md and padding with same-specificity
            // classes, which is the pointer-events bug's family. The palette is
            // kit primary's (bg-accent-600, hover 700) -- keep them in step.
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white transition hover:bg-accent-700 disabled:bg-neutral-300 motion-safe:active:scale-90 dark:disabled:bg-neutral-700"
          >
            {busy ? (
              <SpinnerIcon className="h-4.5 w-4.5" />
            ) : (
              <SendIcon className="h-4.5 w-4.5" />
            )}
          </button>
        </div>
        {slowmodeSeconds !== null && (
          <Note className="mt-1">
            Slowmode is on — one message every {slowmodeSeconds}s.
          </Note>
        )}
      </form>
    </>
  );
}

/**
 * The line under "Drop to attach".
 *
 * It used to read "Images only", which was true and is not any more. Under a
 * blocklist there is nothing short and honest to say -- "anything except
 * thirty-odd executable extensions" is not a caption -- so it says what the
 * limit actually is from the reader's point of view: nothing in particular.
 * An allowlist has a genuinely useful caption and gets one.
 */
function dropHint(policy: FilePolicy): string {
  if (policy.mode === "allow" && policy.extensions.length > 0) {
    return policy.extensions.map((extension) => `.${extension}`).join(" ");
  }
  return "Most file types";
}
