// The sidebar's second form, shaped like NewConversation: create a hub, or
// join a public one by id.

import { useState, type FormEvent } from "react";
import { ApiError, createHub, joinHub } from "../../api/client";
import type { HubVisibility } from "../../api/types";
import { sync } from "../../sync/engine";
import { Button, ErrorText, Input, handleInputProps } from "../kit";

/**
 * Creating a hub, or joining a public one by id -- the sidebar's second
 * form, shaped like NewConversation. The class choice carries its label
 * copy right here, at the moment it is made, because the public class is
 * the one deliberate exception to "the server reads nothing" and the person
 * making it must see that sentence before the hub exists (CLAUDE.md rules
 * 1/9, as amended).
 */
export function NewHub({
  onOpened,
}: {
  onOpened: (channelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<HubVisibility>("private");
  const [joinId, setJoinId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setOpen(false);
    setName("");
    setJoinId("");
    setVisibility("private");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await createHub({ name: name.trim(), visibility });
      sync.invalidateConversations();
      const general = detail.channels[0];
      if (general) onOpened(general.id);
      reset();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not create the hub.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await joinHub(joinId.trim());
      sync.invalidateConversations();
      const first = detail.channels[0];
      if (first) onOpened(first.id);
      reset();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? "No public hub with that ID."
          : caught instanceof ApiError
            ? caught.message
            : "Could not join the hub.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="w-full">
        New hub
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="space-y-2">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Hub name"
          maxLength={100}
        />
        <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
          <input
            type="radio"
            name="hub-visibility"
            checked={visibility === "private"}
            onChange={() => setVisibility("private")}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>
            Private
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              Invitation only. Every channel is end-to-end encrypted, like a
              group chat.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100">
          <input
            type="radio"
            name="hub-visibility"
            checked={visibility === "public"}
            onChange={() => setVisibility("public")}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span>
            Public
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              Anyone with an account can join. Messages are stored readable
              by the server, so search and moderation work. This cannot be
              changed later.
            </span>
          </span>
        </label>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={busy || name.trim().length === 0}
            className="flex-1"
          >
            {busy ? "…" : "Create"}
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="px-3 py-1.5">
            Cancel
          </Button>
        </div>
      </form>
      <form onSubmit={join} className="flex gap-2">
        <Input
          value={joinId}
          onChange={(e) => setJoinId(e.target.value)}
          placeholder="Or join with a hub ID"
          {...handleInputProps}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || joinId.trim().length === 0}
          className="shrink-0"
        >
          Join
        </Button>
      </form>
    </div>
  );
}
