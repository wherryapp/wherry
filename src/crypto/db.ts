// The crypto module's own IndexedDB database.
//
// Separate from the message store's database, deliberately: `store/` keeps
// content and `crypto/` keeps secrets, and the boundary between them should
// be as visible in the browser's storage inspector as it is in the source
// tree. Nothing here ever needs a transaction spanning both -- every
// partial-failure ordering is recoverable through the archive -- so the one
// thing separate databases give up costs nothing.
//
// What lives here today: the unwrapped account private key. This is the
// accepted threat model, the same one keeping decrypted messages in the
// message store accepts: IndexedDB is origin-scoped, so this is safe against
// every other site and readable by anybody with the unlocked device. Later,
// MLS group state and the device's MLS identity key land beside it.

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "messenger-crypto";
const DB_VERSION = 1;
const SECRETS = "secrets";

const ACCOUNT_PRIVATE_KEY = "accountPrivateKey";
const ACCOUNT_PUBLIC_KEY = "accountPublicKey";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(SECRETS)) {
        database.createObjectStore(SECRETS);
      }
    },
  });
  return dbPromise;
}

export async function saveAccountKeypair(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(SECRETS, "readwrite");
  await tx.store.put(publicKey, ACCOUNT_PUBLIC_KEY);
  await tx.store.put(privateKey, ACCOUNT_PRIVATE_KEY);
  await tx.done;
}

/** Null when this browser has never unwrapped the key (or storage was cleared). */
export async function loadAccountKeypair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} | null> {
  const database = await db();
  const tx = database.transaction(SECRETS, "readonly");
  const [publicKey, privateKey] = await Promise.all([
    tx.store.get(ACCOUNT_PUBLIC_KEY) as Promise<Uint8Array | undefined>,
    tx.store.get(ACCOUNT_PRIVATE_KEY) as Promise<Uint8Array | undefined>,
  ]);
  await tx.done;

  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

/**
 * Called on *explicit* logout, alongside store.clear() -- the next person to
 * sign in on this browser must not inherit the key to this account's history
 * any more than the history itself.
 *
 * Deliberately NOT called when a 401 signs the app out. A password reset
 * revokes every session, and a device that wiped its key on that 401 could
 * never perform the "signed-in device re-wraps" recovery the architecture
 * doc promises -- the key surviving here is what makes a reset repairable
 * without the recovery code. A key without a session cannot read anything.
 */
export async function clearAccountKeypair(): Promise<void> {
  const database = await db();
  const tx = database.transaction(SECRETS, "readwrite");
  await tx.store.delete(ACCOUNT_PRIVATE_KEY);
  await tx.store.delete(ACCOUNT_PUBLIC_KEY);
  await tx.done;
}
