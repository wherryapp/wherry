// Local search: what a scan of this device's messages matches, with the
// operations that change what a person sees applied first.
//
// docs/prompts/local-search-plan.md is the plan, and its §1 is the measurement
// that settled the shape: decoding and matching 100,000 messages costs 35 ms
// and the IndexedDB read is the whole cost, so this is a scan with no index.
// The walk belongs to the store (`MessageStore.searchMessages`); this file is
// the answer every backend owes, kept pure so it is tested without a database.
//
// Two rules an index built at ingest would have got wrong, and a scan gets
// right by reading the ops beside the messages:
//
// - An edit is an op aggregated at read time, so the stored bytes of an edited
//   message are the text that was replaced. A hit matches the text on screen:
//   the target sender's newest edit, never the original and never an edit by
//   anybody else (the authority rule `useTimeline` applies).
// - A retracted message never appears, however well it matches.
//
// Matching is predictable on purpose (plan §5): case-insensitive substring,
// whitespace-split terms that must all appear, over the text and attachment
// filenames. No stemming and no ranking beyond newest first. Hub search stems,
// and it is a separate list for a different trust story, so the two never have
// to agree.

import { decodeContent, isMessageOp, type MessageOp } from "../api/payload";
import type { StoredMessage } from "./types";

/** Longer than this is a paste, not a search. The hub search field's cap. */
export const QUERY_MAX = 200;
/** Newest matches returned before a search stops reading. */
export const SEARCH_LIMIT = 100;
const TERMS_MAX = 8;
const SNIPPET_WIDTH = 160;

export type SearchScope =
  /** One conversation: a bounded range over its index. */
  | { conversationId: string }
  /** Everything stored for these conversations: the unbounded scan. */
  | { conversationIds: readonly string[] };

export type SearchOptions = {
  query: string;
  scope: SearchScope;
  /** Who this device's unsent ops belong to, for the authority check. */
  selfUserId: string;
  limit?: number;
  signal?: AbortSignal;
};

export type SearchHit = {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  sentAt: string;
  /** The text a person sees -- the sender's newest edit applied -- in NFC. */
  text: string;
  /** Every attachment filename the message carries, in NFC. */
  filenames: string[];
  edited: boolean;
};

export type SearchResult = {
  hits: SearchHit[];
  /** The limit was reached before the scan finished; older matches may exist. */
  truncated: boolean;
};

/**
 * The terms of a query: whitespace-split, deduplicated without regard to
 * case, capped. NFC so a query typed on one system matches text composed on
 * another (macOS hands out decomposed filenames).
 */
export function parseQuery(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of raw.slice(0, QUERY_MAX).normalize("NFC").split(/\s+/u)) {
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === TERMS_MAX) break;
  }
  return terms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regular expression rather than `toLowerCase().includes`, so matching and
 * the snippet's highlighting fold case the same way and agree on lengths --
 * lowercasing can change a string's length, which would put a highlight in
 * the wrong place.
 */
function termPattern(term: string, flags: string): RegExp {
  return new RegExp(escapeRegExp(term), flags);
}

/**
 * Folds a newest-first walk of stored messages into search hits.
 *
 * **Newest first is a requirement, not a preference.** An op is always newer
 * than the message it targets, so walking newest first means every op has
 * been seen by the time its target arrives, and the first edit seen from a
 * sender is that sender's latest. `useLatestMessages` relies on the same
 * property. An implementation that cannot walk in that order must collect the
 * ops before offering any message.
 */
export class SearchFold {
  readonly #patterns: RegExp[];
  readonly #selfUserId: string;
  /** target -> sender -> that sender's newest edit text. Per sender, so an
   *  edit from somebody without authority cannot shadow the real one. */
  readonly #edits = new Map<string, Map<string, string>>();
  /** target -> the senders who retracted it. */
  readonly #retractions = new Map<string, Set<string>>();

  constructor(terms: readonly string[], selfUserId: string) {
    this.#patterns = terms.map((term) => termPattern(term, "iu"));
    this.#selfUserId = selfUserId;
  }

  /**
   * This device's unsent ops, oldest first as `listOutbox` returns them.
   * Applied before the walk because they are newer than anything stored --
   * the reason an unsent Delete takes a message out of results at once, the
   * way it tombstones in the timeline.
   */
  applyPending(contents: readonly Uint8Array[]): void {
    for (let i = contents.length - 1; i >= 0; i -= 1) {
      const decoded = decodeContent(contents[i]!);
      if (isMessageOp(decoded)) this.#record(decoded, this.#selfUserId);
    }
  }

  /** One stored message, offered newest first. A hit, or null. */
  offer(message: StoredMessage): SearchHit | null {
    // The payload of an undecrypted row is wire bytes, not content.
    if (message.decryptFailed) return null;
    const decoded = decodeContent(message.payload);
    if (isMessageOp(decoded)) {
      this.#record(decoded, message.senderUserId);
      return null;
    }
    if (decoded === "unsupported" || this.#patterns.length === 0) return null;
    if (this.#retractions.get(message.messageId)?.has(message.senderUserId)) {
      return null;
    }

    const edit = this.#edits.get(message.messageId)?.get(message.senderUserId);
    const text = (edit ?? decoded.text).normalize("NFC");
    const filenames = decoded.attachments.flatMap((attachment) =>
      attachment.name ? [attachment.name.normalize("NFC")] : [],
    );
    // Newline-separated: terms never contain whitespace, so no term can match
    // across the join and pretend the text and a filename were one string.
    const haystack =
      filenames.length > 0 ? `${text}\n${filenames.join("\n")}` : text;
    for (const pattern of this.#patterns) {
      if (!pattern.test(haystack)) return null;
    }

    return {
      messageId: message.messageId,
      conversationId: message.conversationId,
      senderUserId: message.senderUserId,
      senderDeviceId: message.senderDeviceId,
      sentAt: message.sentAt,
      text,
      filenames,
      edited: edit !== undefined,
    };
  }

  #record(op: MessageOp, senderUserId: string): void {
    // Reactions change nothing a search reads.
    if (op.kind === "edit") {
      let bySender = this.#edits.get(op.target);
      if (!bySender) {
        bySender = new Map();
        this.#edits.set(op.target, bySender);
      }
      if (!bySender.has(senderUserId)) bySender.set(senderUserId, op.text);
    } else if (op.kind === "retract") {
      let senders = this.#retractions.get(op.target);
      if (!senders) {
        senders = new Set();
        this.#retractions.set(op.target, senders);
      }
      senders.add(senderUserId);
    }
  }
}

/** Whether any term appears in the value, folded the way matching folds. */
export function containsAnyTerm(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => termPattern(term, "iu").test(value));
}

export type SnippetPart = { text: string; hit: boolean };

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The stretch of text around the first match, with every occurrence of every
 * term marked. Parts rather than markup: the text is another person's, and it
 * renders as text.
 */
export function snippet(
  text: string,
  terms: readonly string[],
  width = SNIPPET_WIDTH,
): SnippetPart[] {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return [];

  // Longest first, so "cats" is marked whole rather than as "cat" plus "s".
  // Each term escaped once and the alternation built here: `termPattern`
  // would escape the `|` as well and match nothing at all.
  const pattern =
    terms.length > 0
      ? new RegExp(
          [...terms]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join("|"),
          "giu",
        )
      : null;

  // A third of the window before the first match, so it reads in context.
  const first = pattern?.exec(flat) ?? null;
  let start = first ? Math.max(0, first.index - Math.floor(width / 3)) : 0;
  let end = Math.min(flat.length, start + width);
  start = Math.max(0, end - width);
  if (start > 0 && isLowSurrogate(flat.charCodeAt(start))) start -= 1;
  if (end < flat.length && isLowSurrogate(flat.charCodeAt(end))) end += 1;
  const window = flat.slice(start, end);

  const parts: SnippetPart[] = [];
  const plain = (value: string) => {
    if (value.length === 0) return;
    const last = parts[parts.length - 1];
    if (last && !last.hit) last.text += value;
    else parts.push({ text: value, hit: false });
  };

  if (start > 0) plain("…");
  let at = 0;
  if (pattern) {
    pattern.lastIndex = 0;
    for (const match of window.matchAll(pattern)) {
      if (match[0].length === 0) continue;
      plain(window.slice(at, match.index));
      parts.push({ text: match[0], hit: true });
      at = match.index + match[0].length;
    }
  }
  plain(window.slice(at));
  if (end < flat.length) plain("…");
  return parts;
}
