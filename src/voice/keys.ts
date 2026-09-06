// Call keys, from MLS (docs/prompts/voice-plan.md §6.1).
//
// No second key exchange: every member device already holds the
// conversation's MLS group state, and the RFC 9420 exporter derives a
// per-epoch secret from it that the SFU and the app server never see. The
// transport puts that secret in its keyring at the epoch's index, so a
// frame sealed under epoch N carries index N mod KEYRING_SIZE in its
// trailer and a receiver picks the matching key without any signalling. A
// membership change turns the epoch, which rotates the key exactly as it
// rotates message keys -- a removed device's state is gone and cannot
// derive the next one.
//
// This file imports no media SDK: the derivation is MLS's, and what a
// transport does with the bytes is its own (transport-webview.ts hands
// them to livekit-client's keyring; the native transport will hand them
// to libwebrtc's, with the same HKDF -- the plan's §1.2). The pure parts
// (label, context, index arithmetic) live in rules.ts, tested.

import type { HandshakeOps } from "../crypto/provider";
import { CALL_KEY_LABEL, callKeyContext } from "./rules";

/** 256 bits of exporter output; the transport derives the frame key from it. */
const CALL_KEY_BYTES = 32;

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
