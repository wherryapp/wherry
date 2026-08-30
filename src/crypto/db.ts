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
const DB_VERSION = 2;
const SECRETS = "secrets";
// One record per conversation: the serialized MLS group state. Written only
// inside the conversation's Web Lock -- see crypto/mls.ts.
const MLS_GROUPS = "mlsGroups";
// The private halves of published-but-unconsumed key packages, keyed by an
// auto id. A welcome names one of these; join tries them in turn.
const MLS_KEY_PACKAGES = "mlsKeyPackages";

const ACCOUNT_PRIVATE_KEY = "accountPrivateKey";
const ACCOUNT_PUBLIC_KEY = "accountPublicKey";
const MLS_IDENTITY = "mlsIdentity";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(SECRETS)) {
        database.createObjectStore(SECRETS);
      }
      if (!database.objectStoreNames.contains(MLS_GROUPS)) {
        database.createObjectStore(MLS_GROUPS);
      }
      if (!database.objectStoreNames.contains(MLS_KEY_PACKAGES)) {
        database.createObjectStore(MLS_KEY_PACKAGES, { autoIncrement: true });
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

// ---------------------------------------------------------------------------
// MLS state
// ---------------------------------------------------------------------------
//
// Everything below is called only from crypto/mls.ts, and the group records
// only from inside that conversation's Web Lock. The types are deliberately
// dumb -- bytes and numbers -- because what IndexedDB persists across a
// version bump should not be shaped like a library's internal objects.

/** The device's stable MLS signature keypair. */
export type MlsIdentity = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

export async function loadMlsIdentity(): Promise<MlsIdentity | null> {
  const database = await db();
  const identity = (await database.get(SECRETS, MLS_IDENTITY)) as
    | MlsIdentity
    | undefined;
  return identity ?? null;
}

export async function saveMlsIdentity(identity: MlsIdentity): Promise<void> {
  const database = await db();
  await database.put(SECRETS, identity, MLS_IDENTITY);
}

/** One conversation's serialized group state. */
export type StoredGroup = {
  /** encodeGroupState bytes; the clientConfig is reattached on load. */
  state: Uint8Array;
  /** Convenience copy of groupContext.epoch, for reads without a decode. */
  epoch: number;
};

export async function loadGroup(
  conversationId: string,
): Promise<StoredGroup | null> {
  const database = await db();
  const group = (await database.get(MLS_GROUPS, conversationId)) as
    | StoredGroup
    | undefined;
  return group ?? null;
}

export async function saveGroup(
  conversationId: string,
  group: StoredGroup,
): Promise<void> {
  const database = await db();
  await database.put(MLS_GROUPS, group, conversationId);
}

export async function deleteGroup(conversationId: string): Promise<void> {
  const database = await db();
  await database.delete(MLS_GROUPS, conversationId);
}

/**
 * The private half of a published key package, waiting for the welcome that
 * consumes it. Kept until a join uses it or it is pruned.
 */
export type StoredKeyPackage = {
  /** The wire-encoded public package, for joinGroup. */
  publicWire: Uint8Array;
  initPrivateKey: Uint8Array;
  hpkePrivateKey: Uint8Array;
  signaturePrivateKey: Uint8Array;
  createdAt: string;
};

export async function saveKeyPackages(
  packages: readonly StoredKeyPackage[],
): Promise<void> {
  const database = await db();
  const tx = database.transaction(MLS_KEY_PACKAGES, "readwrite");
  for (const record of packages) await tx.store.put(record);
  await tx.done;
}

export async function listKeyPackages(): Promise<
  { id: number; record: StoredKeyPackage }[]
> {
  const database = await db();
  const tx = database.transaction(MLS_KEY_PACKAGES, "readonly");
  const [keys, values] = await Promise.all([
    tx.store.getAllKeys(),
    tx.store.getAll(),
  ]);
  await tx.done;
  return keys.map((key, index) => ({
    id: key as number,
    record: values[index] as StoredKeyPackage,
  }));
}

export async function deleteKeyPackage(id: number): Promise<void> {
  const database = await db();
  await database.delete(MLS_KEY_PACKAGES, id);
}
