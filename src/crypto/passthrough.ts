// The v1-era E2EProvider: no encryption at all. Kept after the cutover as
// the interface's trivial second implementation -- proof the seam does not
// secretly depend on MLS -- and as a dev instrument (`VITE_E2E=passthrough`).
// It cannot send against the v2 server, which requires an epoch and archive
// payloads it does not produce.
//
// Stateless, deliberately: an MLS provider's state is group keys and epochs,
// and if this file ever grows a field to hold any, something has gone wrong
// with what "passthrough" means.

import {
  E2EError,
  PROTOCOL_PLAINTEXT,
  type AddMemberInput,
  type ArchivePayload,
  type ArchiveRecipient,
  type DecryptInput,
  type E2EProvider,
  type InitSessionInput,
  type ProtocolVersion,
  type WirePayload,
} from "./provider";

export class PassthroughE2EProvider implements E2EProvider {
  readonly protocolVersion: ProtocolVersion = PROTOCOL_PLAINTEXT;

  /** Nothing to establish: there is no group key yet. */
  async initSession(_input: InitSessionInput): Promise<void> {
    // Intentionally empty.
  }

  /** Also nothing. Same reasoning as initSession. */
  async addMember(_input: AddMemberInput): Promise<void> {
    // Intentionally empty.
  }

  async encrypt(
    _conversationId: string,
    plaintext: Uint8Array,
  ): Promise<WirePayload> {
    return {
      protocolVersion: this.protocolVersion,
      // Copied, not aliased, so a caller that retains the source buffer after
      // calling encrypt does not see it mutate out from under the outbox --
      // the same aliasing discipline the server's passthrough keeps.
      payload: new Uint8Array(plaintext),
    };
  }

  /**
   * "Sealing" under v1 is a copy per recipient, which is exactly what the
   * server-side passthrough's encryptForArchive does today. Nothing calls
   * this until the engine goes v2, but the passthrough stays a complete
   * implementation of the interface either way.
   */
  async encryptForArchive(
    _conversationId: string,
    plaintext: Uint8Array,
    recipients: readonly ArchiveRecipient[],
  ): Promise<ArchivePayload[]> {
    return recipients.map((recipient) => ({
      userId: recipient.userId,
      payload: new Uint8Array(plaintext),
    }));
  }

  async decrypt(input: DecryptInput): Promise<Uint8Array> {
    // A version this provider was not built for is refused rather than
    // guessed at. This is what makes a mixed-version inbox safe: whichever
    // version a client cannot handle, it finds out here rather than storing
    // ciphertext as if it were readable text.
    if (input.protocolVersion !== PROTOCOL_PLAINTEXT) {
      throw new E2EError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Message is protocol version ${input.protocolVersion}, ` +
          `and this provider only reads version ${PROTOCOL_PLAINTEXT}`,
      );
    }

    return new Uint8Array(input.payload);
  }
}
