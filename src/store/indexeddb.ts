// MessageStore over IndexedDB.
//
// Uses `idb`, which is a ~1 kB promise wrapper over the native API. The
// dependency earns itself: raw IndexedDB is an event-based API from before
// promises, so every read is a request object with onsuccess and onerror
// handlers, and transaction lifetime interacts with the microtask queue in
// ways that are easy to get wrong by hand. `idb` does not add a data model or
// a query language -- it is the same API with promises.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ConversationPageOptions,
  MessageStore,
  OutboxEntry,
  StoredBlob,
  StoredConversation,
  StoredMessage,
} from "./types";

const DB_NAME = "messenger";
const DB_VERSION = 2;

const MESSAGES = "messages";
const CONVERSATIONS = "conversations";
const OUTBOX = "outbox";
const META = "meta";
const BLOBS = "blobs";

/** The index that makes a timeline query one seek instead of a scan. */
const BY_CONVERSATION = "byConversation";

interface Schema extends DBSchema {
  // Literal keys rather than the consts above: a computed property name in an
  // interface has to be statically known, and spelling them twice is cheaper
  // than the alternatives.
  messages: {
    key: string;
    value: StoredMessage;
    indexes: {
      // [conversationId, messageId]. messageId is UUIDv7, so within a
      // conversation this index is already in send order -- a timeline page is
      // a bounded cursor walk, and paging backwards needs no sort and no
      // separate timestamp index. This is the same property that lets the
      // server use ids as cursors.
      byConversation: [string, string];
    };
  };
  conversations: { key: string; value: StoredConversation };
  outbox: {
    key: string;
    value: OutboxEntry;
    indexes: { byConversation: string };
  };
  meta: { key: string; value: unknown };
  blobs: { key: string; value: StoredBlob };
}

const DEFAULT_PAGE = 50;

/**
 * The highest and lowest values a UUID string can compare against.
 *
 * IndexedDB compares array keys element by element, so a range over
 * [conversationId, messageId] needs bounds on the second element too. UUIDs
 * are lowercase hex and dashes, so "" is below every one of them and "g" is
 * above -- 'g' sorts after 'f', the largest hex digit.
 */
const ID_MIN = "";
const ID_MAX = "g";

export class IndexedDbMessageStore implements MessageStore {
  #db: Promise<IDBPDatabase<Schema>> | null = null;

  #open(): Promise<IDBPDatabase<Schema>> {
    this.#db ??= openDB<Schema>(DB_NAME, DB_VERSION, {
      // Every store is created only if absent, and nothing here assumes it is
      // running against an empty database.
      //
      // This used to create all four unconditionally, which worked only
      // because the version had never changed: `upgrade` runs on the way from
      // *any* older version, so the first bump would have thrown "object store
      // already exists" for every person who had ever opened the app -- while
      // being perfectly fine for whoever tested it in a fresh browser.
      upgrade(db) {
        if (!db.objectStoreNames.contains(MESSAGES)) {
          const messages = db.createObjectStore(MESSAGES, {
            keyPath: "messageId",
          });
          messages.createIndex(BY_CONVERSATION, ["conversationId", "messageId"]);
        }

        if (!db.objectStoreNames.contains(CONVERSATIONS)) {
          db.createObjectStore(CONVERSATIONS, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(OUTBOX)) {
          const outbox = db.createObjectStore(OUTBOX, {
            keyPath: "clientMessageId",
          });
          outbox.createIndex("byConversation", "conversationId");
        }

        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META);
        }

        // Downloaded attachment bytes, and the terminal states that mean there
        // will never be any. Keyed by attachment id.
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS);
        }
      },

      // An arrow function so `this` is the store instance. Another tab is
      // trying to upgrade to a newer version and cannot while this connection
      // is open, so close and drop the handle; the next call reopens at the
      // new version. Without this, a deploy that changes the schema hangs in
      // every tab left open from before it.
      blocking: () => {
        void this.#close();
      },
    });

    return this.#db;
  }

  async #close(): Promise<void> {
    const pending = this.#db;
    this.#db = null;
    try {
      (await pending)?.close();
    } catch {
      // Already closed, or never opened. Either way there is nothing to do.
    }
  }

  async putMessages(messages: readonly StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const db = await this.#open();
    const tx = db.transaction(MESSAGES, "readwrite");

    // put(), not add(). Delivery is at-least-once, so the same message
    // legitimately arrives twice -- redelivered after a failed ack, or read
    // again from /archive on a device that also drained it from the inbox.
    // add() would throw a ConstraintError on the second copy and abort the
    // whole batch; put() makes dedupe a property of the key.
    //
    // One asymmetry: a record whose decrypt failed never overwrites one
    // whose decrypt succeeded. The success direction is the healing path --
    // the forward archive sync re-storing a readable copy over a failed one
    // -- and the failure direction would be that healing undone by a
    // harmless redelivery.
    await Promise.all(
      messages.map(async (message) => {
        if (message.decryptFailed) {
          const existing = (await tx.store.get(message.messageId)) as
            | StoredMessage
            | undefined;
          if (existing && !existing.decryptFailed) return;
        }
        await tx.store.put(message);
      }),
    );

    // The durability point. This resolves when the transaction commits, and
    // the sync engine acks only after it does. Resolving before this would
    // mean acking messages that are not on disk -- and acking is what stops
    // the server ever sending them again.
    await tx.done;
  }

  async existingMessageIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const db = await this.#open();
    const tx = db.transaction(MESSAGES, "readonly");
    const found = await Promise.all(
      ids.map(async (id) => ((await tx.store.getKey(id)) ? id : null)),
    );
    await tx.done;
    return new Set(found.filter((id): id is string => id !== null));
  }

  async getConversationPage(
    conversationId: string,
    options: ConversationPageOptions = {},
  ): Promise<StoredMessage[]> {
    const limit = options.limit ?? DEFAULT_PAGE;
    const db = await this.#open();

    // Newest first, so the upper bound is where the walk starts. With a
    // `before` cursor the bound is that id, exclusive, which is how paging
    // backwards through a long conversation avoids re-reading what it has.
    const upper: [string, string] = [conversationId, options.before ?? ID_MAX];
    const range = IDBKeyRange.bound(
      [conversationId, ID_MIN],
      upper,
      false,
      options.before !== undefined,
    );

    const out: StoredMessage[] = [];
    let cursor = await db
      .transaction(MESSAGES)
      .store.index(BY_CONVERSATION)
      .openCursor(range, "prev");

    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }

    return out;
  }

  async getLatestMessage(
    conversationId: string,
  ): Promise<StoredMessage | undefined> {
    const [latest] = await this.getConversationPage(conversationId, {
      limit: 1,
    });
    return latest;
  }

  async countMessages(conversationId?: string): Promise<number> {
    const db = await this.#open();
    if (!conversationId) return db.count(MESSAGES);
    return db.countFromIndex(
      MESSAGES,
      BY_CONVERSATION,
      IDBKeyRange.bound([conversationId, ID_MIN], [conversationId, ID_MAX]),
    );
  }

  async getBlob(attachmentId: string): Promise<StoredBlob | undefined> {
    const db = await this.#open();
    return db.get(BLOBS, attachmentId);
  }

  async putBlob(attachmentId: string, blob: StoredBlob): Promise<void> {
    const db = await this.#open();
    await db.put(BLOBS, blob, attachmentId);
  }

  async countUnread(
    conversationId: string,
    afterMessageId: string | null,
    excludeSenderUserId: string,
    cap = 99,
  ): Promise<number> {
    const db = await this.#open();

    // Exclusive lower bound when there is a marker: the marked message has
    // been read, everything strictly after it has not. With no marker at all,
    // nothing has been read, so the walk starts at the beginning.
    const range = IDBKeyRange.bound(
      [conversationId, afterMessageId ?? ID_MIN],
      [conversationId, ID_MAX],
      afterMessageId !== null,
      false,
    );

    // A cursor rather than `count`, because your own messages do not count as
    // unread and a count cannot filter. Walking newest-first means the cap is
    // reached early in exactly the case that would otherwise be slowest.
    let cursor = await db
      .transaction(MESSAGES)
      .store.index(BY_CONVERSATION)
      .openCursor(range, "prev");

    let unread = 0;
    while (cursor && unread < cap) {
      if (cursor.value.senderUserId !== excludeSenderUserId) unread += 1;
      cursor = await cursor.continue();
    }

    return unread;
  }

  async mergeReadMarker(
    conversationId: string,
    userId: string,
    messageId: string,
    at: string,
  ): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(CONVERSATIONS, "readwrite");
    const conversation = await tx.store.get(conversationId);

    if (conversation) {
      let changed = false;
      const members = conversation.members.map((member) => {
        if (member.userId !== userId) return member;
        // Forward only, same rule the server enforces. Ids are uuidv7, so a
        // string comparison is a comparison of send order.
        if (member.lastReadMessageId !== null && member.lastReadMessageId >= messageId) {
          return member;
        }
        changed = true;
        return { ...member, lastReadMessageId: messageId, lastReadAt: at };
      });

      if (changed) await tx.store.put({ ...conversation, members });
    }

    await tx.done;
  }

  async putConversations(
    conversations: readonly StoredConversation[],
  ): Promise<void> {
    if (conversations.length === 0) return;
    const db = await this.#open();
    const tx = db.transaction(CONVERSATIONS, "readwrite");
    await Promise.all(conversations.map((c) => tx.store.put(c)));
    await tx.done;
  }

  async listConversations(): Promise<StoredConversation[]> {
    const db = await this.#open();
    return db.getAll(CONVERSATIONS);
  }

  async getConversation(id: string): Promise<StoredConversation | undefined> {
    const db = await this.#open();
    return db.get(CONVERSATIONS, id);
  }

  async enqueueOutbox(entry: OutboxEntry): Promise<void> {
    const db = await this.#open();
    await db.put(OUTBOX, entry);
  }

  async listOutbox(conversationId?: string): Promise<OutboxEntry[]> {
    const db = await this.#open();
    const entries = conversationId
      ? await db.getAllFromIndex(OUTBOX, "byConversation", conversationId)
      : await db.getAll(OUTBOX);

    // Oldest first: the outbox is a queue, and a retry that reordered a
    // person's messages would be worse than the delay it was avoiding.
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolveOutbox(
    clientMessageId: string,
    message: StoredMessage,
  ): Promise<void> {
    const db = await this.#open();

    // Both stores in one transaction. Doing this in two steps has two failure
    // modes and both are visible to the user: deleting first can lose the
    // message entirely if the write then fails, and writing first can leave
    // the outbox entry behind so the message renders twice forever.
    const tx = db.transaction([MESSAGES, OUTBOX], "readwrite");
    await Promise.all([
      tx.objectStore(MESSAGES).put(message),
      tx.objectStore(OUTBOX).delete(clientMessageId),
    ]);
    await tx.done;
  }

  async recordOutboxFailure(
    clientMessageId: string,
    error: string,
    permanent = false,
  ): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(OUTBOX, "readwrite");
    const existing = await tx.store.get(clientMessageId);
    if (existing) {
      await tx.store.put({
        ...existing,
        attempts: existing.attempts + 1,
        lastError: error,
        ...(permanent ? { failedPermanently: true } : {}),
      });
    }
    await tx.done;
  }

  async removeOutbox(clientMessageId: string): Promise<void> {
    const db = await this.#open();
    await db.delete(OUTBOX, clientMessageId);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.#open();
    return (await db.get(META, key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.#open();
    await db.put(META, value, key);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(
      [MESSAGES, CONVERSATIONS, OUTBOX, META],
      "readwrite",
    );
    await Promise.all([
      tx.objectStore(MESSAGES).clear(),
      tx.objectStore(CONVERSATIONS).clear(),
      tx.objectStore(OUTBOX).clear(),
      tx.objectStore(META).clear(),
    ]);
    await tx.done;
  }
}

/**
 * Asks the browser not to evict this origin's storage under disk pressure.
 *
 * Best effort, and the browsers differ. Chrome grants it silently based on
 * engagement, Firefox prompts, Safari largely ignores it -- and Safari also
 * evicts all script-writable storage after roughly seven days without
 * interaction unless the site is installed. So this reduces the chance of
 * losing history but cannot remove it, which is exactly why `/archive` exists
 * and why the app must work when local storage comes back empty.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
