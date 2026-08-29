// The store the rest of the app uses.
//
// One module owns the choice, the same way the server's db/client.ts owns the
// connection pool and crypto/index.ts owns the provider. Components import
// `store` and never construct one, so Phase 5's swap to native SQLite under
// Tauri is a change to this file and nothing else.
//
// A module-level singleton is right here: the store holds one lazily-opened
// database handle, and a second instance would be a second connection to the
// same database for no reason.

import { IndexedDbMessageStore } from "./indexeddb";
import type { MessageStore } from "./types";

export const store: MessageStore = new IndexedDbMessageStore();

export * from "./types";
export { requestPersistentStorage } from "./indexeddb";
