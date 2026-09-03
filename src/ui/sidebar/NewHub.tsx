// Create a hub, or join a public one by id. A button that unfolds into its
// two forms, inside the compose panel (ui/Compose.tsx) since 2026-09-02 --
// it used to sit at the top of the sidebar's hubs section, a full-width row
// for an action taken about once. The fold stays on purpose: the public-
// class copy below must be read at the moment of creation, and a form
// that is always open is a form that gets scrolled past.

import { useState, type FormEvent } from "react";
import { ApiError, createHub, joinHub } from "../../api/client";
import type { HubVisibility } from "../../api/types";
import { sync } from "../../sync/engine";
import { Button, ErrorText, Input, handleInputProps } from "../kit";
import { CLASS_IS_PERMANENT, classLabel, classSentence } from "../hub-class";

/** The order the choice is offered in: sealed, then the two readable ones,
 *  least open first. Invite-only is deliberately not first -- private stays
 *  the default and the top row, because it is the one that promises the
 *  most. */
const HUB_CLASSES = ["private", "invite_only", "public"] as const;

/**
 * Creating a hub, or joining a public one by id. The class choice carries
 * its label copy right here, at the moment it is made, because the two
 * readable classes are the deliberate exception to "the server reads
 * nothing" and the person choosing one must see that sentence before the
 * hub exists (CLAUDE.md rules 1/9, as amended). The sentences come from
 * ui/hub-class.ts so this form, the join page and the hub's own About
 * section cannot drift.
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
        Create or join a hub
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
        {/* One radio per class, with the class's own sentence under it --
            never a sentence written here. Invite-only sits between the two
            it is between: an invite gate like private, readable storage
            like public, and that is exactly what its sentence says. */}
        {HUB_CLASSES.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-start gap-2 text-sm text-neutral-800 dark:text-neutral-100"
          >
            <input
              type="radio"
              name="hub-visibility"
              checked={visibility === option}
              onChange={() => setVisibility(option)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              {classLabel(option)}
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                {classSentence(option)}{" "}
                {option !== "private" && CLASS_IS_PERMANENT}
              </span>
            </span>
          </label>
        ))}
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
