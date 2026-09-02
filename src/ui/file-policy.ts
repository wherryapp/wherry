// Which files may be attached, and the surprisingly sharp business of reading
// an extension off a filename.
//
// ---------------------------------------------------------------------------
// This is a safety rail, not a security boundary -- and it cannot be one
// ---------------------------------------------------------------------------
//
// The server never learns an attachment's type. It takes opaque bytes and
// stores no media type; the real type lives inside the sealed payload
// (api/payload.ts's AttachmentRef), which is exactly where rule 1 requires it
// to live. So there is no place a rule about file types *could* be enforced:
// a modified client can seal and upload whatever it likes and the server has
// nothing to check it against.
//
// What this is for, then, is the sender. It stops somebody attaching the
// wrong thing by accident, it applies the same rule to the picker, a paste, a
// drop and a widget (the reason attach-intake.ts exists), and it gives an
// operator a way to say "not on this instance" without a rebuild. It is the
// same honour-system posture as edit and retraction authorisation, and it
// should be described that way rather than as protection.
//
// The half that actually protects somebody is on the *receiving* side: never
// render an attachment as anything but data, and warn before handing over a
// file whose extension the OS will happily execute. See `isExecutable`.

/**
 * The operator's rule, resolved per user and published by
 * `GET /attachments/usage`.
 *
 * Two modes rather than one list, because the two useful postures are
 * opposites and each is unusable expressed as the other. "Everything except
 * these" is what a general messenger wants; "only these" is what a locked-down
 * instance wants, and it would need an impossibly long list of exclusions to
 * express as a denylist.
 */
export type FilePolicy = {
  mode: "block" | "allow";
  /** Lowercase, no leading dot. */
  extensions: readonly string[];
};

/**
 * Extensions that a double-click runs, on some platform, with no further
 * ceremony.
 *
 * The default denylist, and deliberately not exhaustive -- it names the
 * classic carriers rather than trying to enumerate everything hostile, which
 * is not a winnable game. `.js` is a real vector on Windows (double-clicking
 * one runs it through the Windows Script Host) and is deliberately **absent**,
 * because it is also ubiquitous and legitimate; an instance that would rather
 * refuse it can add it, which is the whole point of the policy being data.
 */
export const DEFAULT_BLOCKED_EXTENSIONS: readonly string[] = [
  // Windows
  "exe", "com", "scr", "pif", "bat", "cmd", "msi", "msp", "cpl", "hta",
  "vbs", "vbe", "jse", "wsf", "wsh", "ps1", "psm1", "reg", "lnk", "scf",
  "inf", "chm", "dll", "sys",
  // Cross-platform runtimes
  "jar",
  // macOS
  "app", "pkg", "command", "workflow",
  // Linux / Android
  "deb", "rpm", "appimage", "run", "apk",
];

export const DEFAULT_FILE_POLICY: FilePolicy = {
  mode: "block",
  extensions: DEFAULT_BLOCKED_EXTENSIONS,
};

/**
 * The extension an operating system will actually act on, lowercased.
 *
 * Three things make this more than `split(".").pop()`:
 *
 * **Windows strips trailing dots and spaces from filenames.** `"evil.exe. "`
 * is opened as `evil.exe`, so reading the extension as `""` (or as `" "`)
 * would wave through the exact filename crafted to do that. Trailing dots and
 * spaces are stripped first, repeatedly.
 *
 * **Only the last extension counts.** `"invoice.pdf.exe"` is an executable,
 * and looking at `pdf` is how that gets waved through. Checking *every*
 * extension instead would be over-eager in the other direction: `"notes.exe.txt"`
 * is a text file, whatever it is named.
 *
 * **A leading dot is not an extension.** `".gitignore"` is a dotfile with no
 * extension, not a file of type `gitignore`.
 */
export function fileExtension(name: string): string | null {
  // Windows' own normalisation, applied before we read anything.
  const trimmed = name.replace(/[. ]+$/u, "");
  if (trimmed.length === 0) return null;

  // Take the basename first: a path separator would otherwise let a directory
  // name supply the extension. Browsers do not usually give paths, but a
  // widget or a drop can produce whatever it likes.
  const base = trimmed.split(/[/\\]/u).pop() ?? trimmed;

  const dot = base.lastIndexOf(".");
  // `dot <= 0` covers both "no dot at all" and a leading dot (a dotfile).
  if (dot <= 0 || dot === base.length - 1) return null;

  return base.slice(dot + 1).toLowerCase();
}

/** Whether the policy permits a file with this name. */
export function isFileAllowed(name: string, policy: FilePolicy): boolean {
  const extension = fileExtension(name);
  const listed = extension !== null && policy.extensions.includes(extension);

  if (policy.mode === "allow") {
    // No extension cannot satisfy an allowlist -- there is nothing to match,
    // and "allow only these" has to mean it.
    return listed;
  }
  // Blocklist: anything not named, including a file with no extension.
  return !listed;
}

/**
 * Whether to warn before handing this file to the person receiving it.
 *
 * Deliberately independent of the policy. An operator who *allows* `.exe` has
 * decided their instance may carry one; they have not decided that somebody
 * should be handed one with no indication of what it is. This is the receiving
 * side's rail and it answers the same way regardless of what the sender's
 * instance permitted.
 */
export function isExecutable(name: string): boolean {
  const extension = fileExtension(name);
  return extension !== null && DEFAULT_BLOCKED_EXTENSIONS.includes(extension);
}

/**
 * The `accept` attribute for the file picker, or undefined for "anything".
 *
 * A denylist has no `accept` expression -- the attribute can only say what is
 * permitted -- which is precisely why the rule cannot live in the markup and
 * `isFileAllowed` has to be applied to whatever comes back. Under an
 * allowlist the attribute is a real convenience: the OS picker greys out
 * everything else rather than letting somebody choose a file that is then
 * refused.
 */
export function acceptAttribute(policy: FilePolicy): string | undefined {
  if (policy.mode !== "allow") return undefined;
  if (policy.extensions.length === 0) return undefined;
  return policy.extensions.map((extension) => `.${extension}`).join(",");
}

/**
 * A filename safe to render.
 *
 * Bidirectional control characters are the reason. A U+202E (right-to-left
 * override) placed before "gnp.exe" makes the name *display* as though it
 * ends in ".png" while the OS still sees ".exe" -- the classic filename
 * spoof. Stripping the controls means the name shown is the name that
 * matters. Other C0/C1 controls go with them: a newline in a filename is only
 * ever there to push something out of view.
 */
export function displayFileName(name: string): string {
  return (
    name
      // Bidi controls: LRM/RLM/ALM, the LRE..RLO + PDF block, and the
      // isolates (LRI/RLI/FSI/PDI). Written as escapes on purpose -- these
      // are invisible, and a literal one in this source would be a character
      // nobody reviewing this file could see.
      .replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/gu, "")
      // C0 and C1 control characters. A newline in a filename is only ever
      // there to push something out of view.
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "")
      .trim()
  );
}
