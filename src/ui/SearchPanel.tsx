// Search in the conversations the server cannot read, run on this device.
//
// The plan is docs/prompts/local-search-plan.md and the answer is
// store/search.ts's -- an edited message is found by its new text, a retracted
// one never. What this file owns is the rule the plan puts on the UI: local
// results and a readable hub's server results are never one list. A public or
// invite-only channel is left out of the local scan and pointed at its hub's
// own search, because this device holds only a window of such a channel's
// history while the server holds all of it, and a local list that quietly
// missed most of a channel would read as that channel's whole answer.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "../store";
import {
  containsAnyTerm,
  parseQuery,
  QUERY_MAX,
  snippet,
  type SearchHit,
  type SearchResult,
} from "../store/search";
import type { StoredConversation } from "../store/types";
import { displayFileName } from "./file-policy";
import { conversationTitle, memberName } from "./format";
import { classLabel, isServerReadable } from "./hub-class";
import { Button, ErrorText, FileIcon, Input, Note, Panel } from "./kit";

export type SearchState = {
  /** The conversation search was opened from; null when opened from the list. */
  from: string | null;
  query: string;
  scope: "conversation" | "all";
};

/**
 * Within one conversation a search is a bounded range read and runs as you
 * type. Across everything it is a whole-store scan -- half a second to two on
 * a desktop at the sizes measured -- so it runs on submit only (plan §2).
 */
const TYPE_AHEAD_MS = 200;

type Request = { query: string; scope: SearchState["scope"] };

export function SearchPanel({
  conversations,
  selfUserId,
  state,
  onStateChange,
  onJump,
  onOpenHub,
  onClose,
}: {
  conversations: readonly StoredConversation[];
  selfUserId: string;
  /** Owned by the caller, so a jump and a return find the same search. */
  state: SearchState;
  onStateChange: (state: SearchState) => void;
  onJump: (hit: SearchHit) => void;
  onOpenHub: (hubId: string) => void;
  onClose: () => void;
}) {
  const current =
    state.from === null
      ? undefined
      : conversations.find((conversation) => conversation.id === state.from);
  const scope = current ? state.scope : "all";
  const readableCurrent =
    current !== undefined && isServerReadable(current.hubVisibility);

  const byId = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );
  const searchable = useMemo(
    () =>
      conversations
        .filter((conversation) => !isServerReadable(conversation.hubVisibility))
        .map((conversation) => conversation.id),
    [conversations],
  );
  const readableCount = conversations.length - searchable.length;

  // Read at the moment a search starts rather than as effect dependencies: the
  // conversation list is re-read on every sync tick, and a search must not
  // restart each time it is.
  const targets = useRef({ currentId: current?.id ?? null, searchable });
  targets.current = { currentId: current?.id ?? null, searchable };

  const [request, setRequest] = useState<Request | null>(
    state.query.trim() ? { query: state.query, scope } : null,
  );
  const [found, setFound] = useState<{ query: string; result: SearchResult } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scope !== "conversation") return;
    const timer = window.setTimeout(
      () => setRequest({ query: state.query, scope }),
      TYPE_AHEAD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.query, scope]);

  useEffect(() => {
    if (request === null || parseQuery(request.query).length === 0) {
      setFound(null);
      setBusy(false);
      setError(null);
      return;
    }
    if (request.scope === "conversation" && readableCurrent) return;

    const controller = new AbortController();
    const { currentId, searchable: ids } = targets.current;
    setBusy(true);
    setError(null);
    store
      .searchMessages({
        query: request.query,
        scope:
          request.scope === "conversation" && currentId !== null
            ? { conversationId: currentId }
            : { conversationIds: ids },
        selfUserId,
        signal: controller.signal,
      })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setFound({ query: request.query, result });
          setBusy(false);
        },
        (caught: unknown) => {
          if (controller.signal.aborted) return;
          console.warn("local search failed", caught);
          setError("Could not search this device's messages.");
          setBusy(false);
        },
      );
    return () => controller.abort();
  }, [request, selfUserId, readableCurrent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setRequest({ query: state.query, scope });
  }

  function chooseScope(next: SearchState["scope"]) {
    if (next === scope) return;
    onStateChange({ ...state, scope: next });
    // Choosing where to look is as deliberate as pressing Search.
    if (state.query.trim()) setRequest({ query: state.query, scope: next });
  }

  const terms = found ? parseQuery(found.query) : [];

  return (
    <Panel title="Search" onClose={onClose}>
      <div className="space-y-3 p-4">
        {current && (
          <div role="group" aria-label="Where to search" className="flex gap-1.5">
            <ScopeButton
              pressed={scope === "conversation"}
              onClick={() => chooseScope("conversation")}
            >
              {conversationTitle(current, selfUserId)}
            </ScopeButton>
            <ScopeButton pressed={scope === "all"} onClick={() => chooseScope("all")}>
              All conversations
            </ScopeButton>
          </div>
        )}

        <form onSubmit={submit} className="flex gap-2">
          <Input
            type="search"
            aria-label="Search messages"
            value={state.query}
            onChange={(event) => onStateChange({ ...state, query: event.target.value })}
            placeholder={scope === "conversation" ? "Search this conversation" : "Search all messages"}
            maxLength={QUERY_MAX}
            autoFocus
          />
          <Button
            type="submit"
            size="sm"
            loading={busy && scope === "all"}
            disabled={state.query.trim().length === 0}
            className="shrink-0"
          >
            Search
          </Button>
        </form>

        {scope === "conversation" && readableCurrent && current?.hubId ? (
          <div className="space-y-2">
            <Note>
              This channel is in {current.hubVisibility === "invite_only" ? "an" : "a"}{" "}
              {classLabel(current.hubVisibility ?? "public").toLowerCase()} hub, whose
              messages the server stores readable, so it searches every channel there —
              not only what this device holds.
            </Note>
            <Button size="sm" onClick={() => onOpenHub(current.hubId!)}>
              Search the hub
            </Button>
          </div>
        ) : (
          <>
            <Note>
              Searched on this device. The server can't read these messages, so it can't
              search them.
              {scope === "all" && readableCount > 0 &&
                " Public and invite-only hub channels are searched from their hub."}
            </Note>
            {error && <ErrorText>{error}</ErrorText>}
            {busy && scope === "conversation" && <Note>Searching…</Note>}
            {found && !error && (
              <Results
                result={found.result}
                terms={terms}
                showConversation={scope === "all"}
                byId={byId}
                selfUserId={selfUserId}
                onJump={onJump}
              />
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function ScopeButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`max-w-[50%] truncate rounded-full px-3 py-1 text-xs font-medium transition ${
        pressed
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

function Results({
  result,
  terms,
  showConversation,
  byId,
  selfUserId,
  onJump,
}: {
  result: SearchResult;
  terms: readonly string[];
  showConversation: boolean;
  byId: ReadonlyMap<string, StoredConversation>;
  selfUserId: string;
  onJump: (hit: SearchHit) => void;
}) {
  const { hits, truncated } = result;
  const summary =
    hits.length === 0
      ? "No messages matched."
      : truncated
        ? `The newest ${hits.length} matches.`
        : hits.length === 1
          ? "1 match."
          : `${hits.length} matches.`;

  return (
    <div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400" role="status">
        {summary}
      </p>
      <ul className="mt-1 divide-y divide-neutral-100 dark:divide-neutral-800">
        {hits.map((hit) => {
          const conversation = byId.get(hit.conversationId);
          const sender =
            hit.senderUserId === selfUserId
              ? "You"
              : conversation
                ? memberName(conversation, hit.senderUserId)
                : "Someone";
          const parts = snippet(hit.text, terms);
          const names = hit.filenames.filter((name) => containsAnyTerm(name, terms));
          return (
            <li key={hit.messageId}>
              <button
                type="button"
                onClick={() => onJump(hit)}
                className="block w-full py-2 text-left"
              >
                <span className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 truncate font-medium text-neutral-900 dark:text-neutral-100">
                    {sender}
                    {showConversation && conversation && (
                      <span className="font-normal text-neutral-500 dark:text-neutral-400">
                        {" · "}
                        {conversationTitle(conversation, selfUserId)}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto shrink-0 text-neutral-500 dark:text-neutral-400">
                    {new Date(hit.sentAt).toLocaleDateString()}
                  </span>
                </span>
                {parts.length > 0 && (
                  <span className="mt-0.5 line-clamp-2 block break-words text-sm text-neutral-700 dark:text-neutral-300">
                    {parts.map((part, index) =>
                      part.hit ? (
                        <mark
                          key={index}
                          className="rounded-sm bg-accent-100 text-inherit dark:bg-accent-800"
                        >
                          {part.text}
                        </mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                    {hit.edited && (
                      <span className="ml-1 text-xs text-neutral-400 dark:text-neutral-500">
                        (edited)
                      </span>
                    )}
                  </span>
                )}
                {names.map((name) => (
                  <span
                    key={name}
                    className="mt-0.5 flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300"
                  >
                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{displayFileName(name)}</span>
                  </span>
                ))}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
