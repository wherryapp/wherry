# Wherry — client

The client for [Wherry](https://wherry.app), a small self-hosted,
end-to-end encrypted messenger. React + Vite, wrapped in Tauri v2 for
desktop, iOS and Android from this same source.

## This is a mirror

This repository is generated from a private monorepo by `git subtree
split`, so the history here is real but one-way: **pull requests and
commits pushed here will be overwritten** by the next sync. Issues are
welcome; if you want to send a change, open an issue first and we will
sort out the route.

The server is not published. That is deliberate and it is the honest
division: the client is the half worth reading, because the server never
sees plaintext and so cannot be the thing you have to trust. Everything
below is checkable from this source.

## What the encryption actually is

- **MLS (RFC 9420)** via [ts-mls](https://github.com/LukaJCB/ts-mls), behind
  the `E2EProvider` interface in `src/crypto/provider.ts` — one seam, one
  real implementation (`src/crypto/mls.ts`), chosen in `src/crypto/index.ts`.
- Message envelopes carry MLS ciphertext, one row per recipient *device*.
- History is sealed per conversation under a key the server only ever holds
  wrapped (`src/crypto/history.ts`); attachments are sealed per blob before
  upload (`src/crypto/blob.ts`).
- Account keys are generated client-side and wrapped under the password.
- ts-mls is **not independently audited.** The provider interface is the
  hedge if that has to change.

The one deliberate exception: channels in a **public** hub store content
server-readable, so that search and moderation can exist in rooms anyone
can already join. It is labelled in the UI at creation and on every public
surface. Direct messages, groups and private-hub channels are sealed.

## Running it

```bash
pnpm install
pnpm dev
```

That expects a server on the other end. `VITE_API_BASE` selects it; unset,
the client talks to a same-origin `/api`.

```bash
pnpm build            # web
pnpm build:desktop    # bakes VITE_API_BASE for the shells
pnpm tauri dev        # desktop shell (needs the Rust toolchain)
```

## Licence

None yet — all rights reserved for now. Published for inspection and
verification rather than reuse. If you want to do something with it, ask.
