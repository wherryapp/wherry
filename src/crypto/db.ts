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
import { decodeBase64, encodeBase64 } from "../api/base64";
import { vaultDelete, vaultGet, vaultSet } from "../vault";

// In the Tauri shells the account keypair is additionally mirrored into
// the OS keychain -- see vault.ts. The reason lives here and not with the
// session mirror: an evicted IndexedDB without this backup is the
// lost-device path (recovery code or another signed-in device) for a
// person who did nothing but leave the app closed too long. Only the
// account keypair: everything else in this database is either
// device-scoped and rebuilt by the external-commit join path (MLS state),
// or account-scoped and re-fetchable once the account key exists again
// (history keys, via GET /history-keys).
const VAULT_ACCOUNT_KEYS = "accountKeys";

const DB_NAME = "messenger-crypto";
const DB_VERSION = 3;
const SECRETS = "secrets";
// Unwrapped history keys, keyed [conversationId, generation]. Their own
// store rather than composite string keys in `secrets`, because "the latest
// generation for a conversation" is an ordered range read and "10" sorts
// before "2" as a string.
const HISTORY_KEYS = "historyKeys";
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
      if (!database.objectStoreNames.contains(HISTORY_KEYS)) {
        database.createObjectStore(HISTORY_KEYS);
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
  // Fire-and-forget: the IndexedDB write above is the source of truth, and
  // a keychain that cannot be written must not fail an unlock.
  void vaultSet(
    VAULT_ACCOUNT_KEYS,
    JSON.stringify({
      publicKey: encodeBase64(publicKey),
      privateKey: encodeBase64(privateKey),
    }),
  );
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

  if (!publicKey || !privateKey) return restoreKeypairFromVault();
  return { publicKey, privateKey };
}

/**
 * The eviction path: IndexedDB came up empty, so ask the keychain. On a
 * hit the pair is written back to IndexedDB (the normal home) and returned
 * as if it had never been gone. Null everywhere the vault is a no-op --
 * the web, and any shell whose keychain has nothing -- which leaves the
 * caller's contract exactly what it always was.
 */
async function restoreKeypairFromVault(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} | null> {
  const raw = await vaultGet(VAULT_ACCOUNT_KEYS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { publicKey: string; privateKey: string };
    if (
      typeof parsed?.publicKey !== "string" ||
      typeof parsed?.privateKey !== "string"
    ) {
      return null;
    }
    const publicKey = decodeBase64(parsed.publicKey);
    const privateKey = decodeBase64(parsed.privateKey);
    await saveAccountKeypair(publicKey, privateKey);
    return { publicKey, privateKey };
  } catch {
    // A corrupt keychain entry reads as no entry; the account unlock flow
    // it falls back to (password or recovery code) rewrites both copies.
    return null;
  }
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
  // The keychain mirror obeys the same lifetime, for the same reason: the
  // next person to sign in on this install must not inherit the key.
  void vaultDelete(VAULT_ACCOUNT_KEYS);
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
 * Everything that belongs to *this device* rather than to the account: every
 * group's ratchet state, the unconsumed key packages, and the MLS signature
 * identity.
 *
 * For the `UNKNOWN_DEVICE` recovery, where the server has revoked the device
 * this state was built for. None of it can be carried into the replacement:
 * a group's state names the old device's leaf, the published key packages
 * hang off a device row that is gone, and the identity key is the thing
 * other members verify that leaf against. Reusing any of it would put a
 * device in a group under an identity the roster no longer lists.
 *
 * Deliberately NOT touched: the account keypair and the history keys. Both
 * are account-scoped -- the account key is what a password unlocks and the
 * history keys are wrapped to it -- so a device change is not a reason to
 * lose either, and clearing them is what would push somebody towards their
 * recovery code for no reason.
 */
export async function clearDeviceCrypto(): Promise<void> {
  const database = await db();
  const tx = database.transaction([MLS_GROUPS, MLS_KEY_PACKAGES, SECRETS], "readwrite");
  await tx.objectStore(MLS_GROUPS).clear();
  await tx.objectStore(MLS_KEY_PACKAGES).clear();
  await tx.objectStore(SECRETS).delete(MLS_IDENTITY);
  await tx.done;
}

// ---------------------------------------------------------------------------
// History keys (protocol v3)
// ---------------------------------------------------------------------------
//
// One record per (conversation, generation): the unwrapped 32-byte history
// key. Written by crypto/history.ts when a wrapped key is ingested or a
// rotation minted locally; read at archive seal and open time. Same accepted
// threat model as the account private key above.

export async function saveHistoryKey(
  conversationId: string,
  generation: number,
  key: Uint8Array,
): Promise<void> {
  const database = await db();
  await database.put(HISTORY_KEYS, key, [conversationId, generation]);
}

export async function loadHistoryKey(
  conversationId: string,
  generation: number,
): Promise<Uint8Array | null> {
  const database = await db();
  const key = (await database.get(HISTORY_KEYS, [conversationId, generation])) as
    | Uint8Array
    | undefined;
  return key ?? null;
}

/** The highest cached generation for a conversation, or null. */
export async function latestHistoryKey(
  conversationId: string,
): Promise<{ generation: number; key: Uint8Array } | null> {
  const database = await db();
  const tx = database.transaction(HISTORY_KEYS, "readonly");
  // [conversationId, anything] sorts inside this bound; openCursor with
  // "prev" lands on the highest generation without loading the rest.
  const range = IDBKeyRange.bound(
    [conversationId, 0],
    [conversationId, Number.MAX_SAFE_INTEGER],
  );
  const cursor = await tx.store.openCursor(range, "prev");
  const found = cursor
    ? {
        generation: (cursor.key as [string, number])[1],
        key: cursor.value as Uint8Array,
      }
    : null;
  await tx.done;
  return found;
}

/** Every cached (conversation, generation) pair -- the ingest dedupe read. */
export async function listHistoryKeyIds(): Promise<
  { conversationId: string; generation: number }[]
> {
  const database = await db();
  const keys = await database.getAllKeys(HISTORY_KEYS);
  return keys.map((key) => {
    const [conversationId, generation] = key as [string, number];
    return { conversationId, generation };
  });
}

/**
 * Explicit-logout hygiene, beside clearAccountKeypair and for the same
 * reason: the next person to sign in on this browser must not inherit keys
 * to this account's history. (And with the same caveat: keys without a
 * session and without ciphertext read nothing on their own.)
 */
export async function clearHistoryKeys(): Promise<void> {
  const database = await db();
  await database.clear(HISTORY_KEYS);
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
