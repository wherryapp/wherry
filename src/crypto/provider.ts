// The client half of the seam described in server/src/crypto/provider.ts.
//
// Under real end-to-end encryption the client is where keys live and where
// encrypt/decrypt actually run -- see CLAUDE.md rule 7 and the long comment at
// the top of the server file. Today nothing calls this but the passthrough
// implementation, because there is nothing to encrypt with yet. The value is
// the same as it was on the server: the sync engine is written against "a
// provider turns plaintext into wire bytes and back" instead of "payload is
// whatever decodeBase64 hands me", so the day MLS lands, that is a new file
// implementing this interface plus a different line in index.ts -- not a
// rewrite of the sync engine.
//
// ---------------------------------------------------------------------------
// Why this is not a copy of the server's interface
// ---------------------------------------------------------------------------
//
// The server's `encrypt` returns one payload per recipient *device*, because
// the server is the one fanning a send out to N envelope rows. The client
// never sees that fan-out: `POST /conversations/:id/messages` takes one
// payload and `GET /inbox` hands back one payload per message, regardless of
// how many devices are involved. So the client seam is scoped to what the
// wire actually carries -- one plaintext in, one wire payload out, and back --
// rather than mirroring the server's per-recipient array.
//
// This still holds under MLS. A group's ciphertext is one blob copied to
// every member device's envelope (see the server file's note on `encrypt`),
// so a client sealing a message for its own conversation produces exactly the
// one payload the wire already has a field for.
//
// initSession, addMember and encryptForArchive stay on the interface, as
// no-ops, for the day the client is the one managing MLS group state and
// sealing archive rows -- neither is exercised by anything today, the way the
// server's own decrypt is documented as dead code that must stay dead.

export const PROTOCOL_PLAINTEXT = 1;
export const PROTOCOL_MLS = 2;

export type ProtocolVersion = typeof PROTOCOL_PLAINTEXT | typeof PROTOCOL_MLS;

/** What actually crosses the wire, and what the local store persists. */
export type WirePayload = {
  protocolVersion: ProtocolVersion;
  payload: Uint8Array;
};

export type InitSessionInput = {
  conversationId: string;
  /** Every device that should be able to read the conversation at creation. */
  memberDeviceIds: readonly string[];
};

export type AddMemberInput = {
  conversationId: string;
  deviceId: string;
};

export type DecryptInput = {
  conversationId: string;
  /**
   * Read straight off the envelope or archive row, so it is whatever the
   * server sent rather than a value this process chose -- hence `number`, not
   * `ProtocolVersion`. Validating it is the provider's job, same as on the
   * server.
   */
  protocolVersion: number;
  payload: Uint8Array;
};

export type E2EErrorCode = "UNSUPPORTED_PROTOCOL_VERSION";

/** Same shape as the server's E2EError: a code, never anything HTTP-shaped. */
export class E2EError extends Error {
  readonly code: E2EErrorCode;

  constructor(code: E2EErrorCode, message: string) {
    super(message);
    this.name = "E2EError";
    this.code = code;
  }
}

export interface E2EProvider {
  /**
   * The version this provider stamps on messages it sends. Exposed so callers
   * never hardcode a number -- `PROTOCOL_PLAINTEXT` was hardcoded at the one
   * send call site before this interface existed, which is exactly the thing
   * this file is for.
   */
  readonly protocolVersion: ProtocolVersion;

  /** Establish the group for a new conversation. A no-op under passthrough. */
  initSession(input: InitSessionInput): Promise<void>;

  /** Add a device to an existing conversation. Also a no-op under passthrough. */
  addMember(input: AddMemberInput): Promise<void>;

  /**
   * Turn outgoing content bytes into what gets sent on the wire and kept in
   * the outbox. Called once, at compose time -- not re-run on retry, since a
   * retry resends the same wire bytes rather than re-encrypting.
   */
  encrypt(conversationId: string, plaintext: Uint8Array): Promise<WirePayload>;

  /**
   * Turn a received envelope or archive payload back into content bytes.
   *
   * Called once, when a message is first stored -- not at render time. A
   * ratcheting protocol may no longer hold the key for an old epoch by the
   * time something is rendered, so the store keeps the decrypted bytes rather
   * than re-deriving them on every read. See the note on `StoredMessage.payload`
   * in store/types.ts.
   */
  decrypt(input: DecryptInput): Promise<Uint8Array>;
}
