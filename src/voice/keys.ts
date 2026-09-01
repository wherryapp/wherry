// Call keys, from MLS (docs/prompts/voice-plan.md §6.1).
//
// No second key exchange: every member device already holds the
// conversation's MLS group state, and the RFC 9420 exporter derives a
// per-epoch secret from it that the SFU and the app server never see. The
// key lands in livekit-client's keyring at the epoch's index, so a frame
// sealed under epoch N carries index N mod KEYRING_SIZE in its trailer and
// a receiver picks the matching key without any signalling. A membership
// change turns the epoch, which rotates the key exactly as it rotates
// message keys -- a removed device's state is gone and cannot derive the
// next one.
//
// The only file besides session.ts that imports livekit-client. The pure
// parts (label, context, index arithmetic) live in rules.ts, tested.

import { BaseKeyProvider, createKeyMaterialFromBuffer } from "livekit-client";
import type { HandshakeOps } from "../crypto/provider";
import { CALL_KEY_LABEL, callKeyContext, keyIndexFor, KEYRING_SIZE } from "./rules";

/** 256 bits of exporter output; the SDK HKDFs it into the AES-GCM key. */
const CALL_KEY_BYTES = 32;

/**
 * A shared key set by index. The SDK's own ExternalE2EEKeyProvider takes
 * no index (one passphrase for the room's life), which is one key short of
 * what an epoch turn needs; this subclass uses the same shared-key mode
 * and reaches the protected setter with the epoch's index. Ratcheting is
 * off -- MLS is the ratchet -- and failure tolerance is disabled so a frame
 * under a key this device does not (yet) hold is dropped rather than
 * triggering a blind ratchet attempt.
 */
export class CallKeyProvider extends BaseKeyProvider {
  constructor() {
    super({
      sharedKey: true,
      ratchetWindowSize: 0,
      failureTolerance: -1,
      keyringSize: KEYRING_SIZE,
    });
  }

  async setEpochKey(secret: Uint8Array, epoch: number): Promise<void> {
    // A copy, so the SDK owns a buffer that is exactly the key and nothing
    // else shares it.
    const material = new Uint8Array(secret);
    const key = await createKeyMaterialFromBuffer(material.buffer);
    this.onSetEncryptionKey(key, undefined, keyIndexFor(epoch));
  }
}

/**
 * The current epoch's call key for this conversation and call, or null
 * when this device holds no group state yet (an external join still
 * pending -- session.ts waits and retries).
 */
export async function deriveCallKey(
  handshake: HandshakeOps,
  conversationId: string,
  callId: string,
): Promise<{ epoch: number; secret: Uint8Array } | null> {
  return await handshake.exportSecret(
    conversationId,
    CALL_KEY_LABEL,
    callKeyContext(callId),
    CALL_KEY_BYTES,
  );
}
