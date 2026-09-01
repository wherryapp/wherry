// The OS keychain, from the webview's side.
//
// Why this exists: WebKit is allowed to evict an inactive app's IndexedDB
// and localStorage, and on iOS it does. In a browser that eviction is the
// user clearing site data -- a genuine "new device". Inside the installed
// app it just *happens*, and what it costs is exactly the two things the
// architecture cannot regrow from the server:
//
//   - the account keypair (crypto/db.ts) -- without it, recovering history
//     means the recovery code or another signed-in device: the lost-device
//     path, triggered by nothing the person did;
//   - the device id (api/session.ts) -- without it, the next login mints a
//     phantom device row and every future message fans out one envelope
//     more, the exact quiet failure session.ts documents at length.
//
// So the Tauri shells mirror those, plus the session token, into the OS
// keychain (Keychain on macOS/iOS, Credential Manager on Windows; a no-op
// on Linux -- see src-tauri/lib.rs) and restore them at startup when the
// webview's copy is gone. The webview storage stays the source of truth;
// the vault is a backup that only ever speaks when the original is lost.
//
// Everything here is best-effort by design. A keychain that refuses to
// write must never break login, and a keychain that refuses to read just
// means eviction costs what it used to. Outside the Tauri shells every
// function is an inert no-op, so callers never branch.

import { isTauriShell } from "./api/shell";

async function invoke<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(command, args);
}

/** Null outside the shell, on a miss, and on any keychain failure. */
export async function vaultGet(key: string): Promise<string | null> {
  if (!isTauriShell()) return null;
  try {
    return await invoke<string | null>("vault_get", { key });
  } catch {
    return null;
  }
}

/** Fire-and-forget shape at the call sites; failures are absorbed here. */
export async function vaultSet(key: string, value: string): Promise<void> {
  if (!isTauriShell()) return;
  try {
    await invoke<void>("vault_set", { key, value });
  } catch {
    // The webview copy still exists; the backup just didn't happen.
  }
}

export async function vaultDelete(key: string): Promise<void> {
  if (!isTauriShell()) return;
  try {
    await invoke<void>("vault_delete", { key });
  } catch {
    // Worst case a secret outlives its account on this device's keychain;
    // the next sign-in's vaultSet overwrites it.
  }
}
