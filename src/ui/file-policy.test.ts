import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FILE_POLICY,
  acceptAttribute,
  displayFileName,
  fileExtension,
  isExecutable,
  isFileAllowed,
  type FilePolicy,
} from "./file-policy.js";

// ---------------------------------------------------------------------------
// Reading the extension
// ---------------------------------------------------------------------------

test("the ordinary case", () => {
  assert.equal(fileExtension("report.pdf"), "pdf");
  assert.equal(fileExtension("archive.tar.gz"), "gz");
});

test("case is normalised, because filesystems do not care", () => {
  assert.equal(fileExtension("SETUP.EXE"), "exe");
  assert.equal(fileExtension("Report.PdF"), "pdf");
});

test("Windows strips trailing dots and spaces, so this must too", () => {
  // "evil.exe. " opens as evil.exe on Windows. Reading the extension as ""
  // would wave through the exact name crafted to do that.
  assert.equal(fileExtension("evil.exe. "), "exe");
  assert.equal(fileExtension("evil.exe..."), "exe");
  assert.equal(fileExtension("evil.exe "), "exe");
});

test("only the LAST extension counts", () => {
  assert.equal(fileExtension("invoice.pdf.exe"), "exe", "the dangerous one");
  assert.equal(fileExtension("notes.exe.txt"), "txt", "and not over-eagerly");
});

test("a dotfile has no extension", () => {
  assert.equal(fileExtension(".gitignore"), null);
  assert.equal(fileExtension(".env"), null);
});

test("no extension at all", () => {
  assert.equal(fileExtension("Makefile"), null);
  assert.equal(fileExtension("trailing."), null);
  assert.equal(fileExtension(""), null);
  assert.equal(fileExtension("   "), null);
});

test("a path separator cannot supply the extension", () => {
  assert.equal(fileExtension("photos.d/report"), null);
  assert.equal(fileExtension("c:\\photos.d\\report"), null);
  assert.equal(fileExtension("dir.zip/file.txt"), "txt");
});

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test("the default policy blocks executables and permits everything else", () => {
  assert.equal(isFileAllowed("holiday.jpg", DEFAULT_FILE_POLICY), true);
  assert.equal(isFileAllowed("accounts.xlsx", DEFAULT_FILE_POLICY), true);
  assert.equal(isFileAllowed("Makefile", DEFAULT_FILE_POLICY), true);
  assert.equal(isFileAllowed("setup.exe", DEFAULT_FILE_POLICY), false);
  assert.equal(isFileAllowed("run.BAT", DEFAULT_FILE_POLICY), false);
  assert.equal(isFileAllowed("app.apk", DEFAULT_FILE_POLICY), false);
});

test("the disguises the extension reader exists for are all refused", () => {
  for (const name of ["invoice.pdf.exe", "evil.exe. ", "SETUP.EXE", "x.exe..."]) {
    assert.equal(isFileAllowed(name, DEFAULT_FILE_POLICY), false, name);
  }
});

test("allow mode permits only what it names", () => {
  const policy: FilePolicy = { mode: "allow", extensions: ["pdf", "png"] };
  assert.equal(isFileAllowed("a.pdf", policy), true);
  assert.equal(isFileAllowed("a.PNG", policy), true);
  assert.equal(isFileAllowed("a.jpg", policy), false);
  assert.equal(isFileAllowed("a.pdf.exe", policy), false);
});

test("an allowlist refuses a file with no extension -- there is nothing to match", () => {
  const policy: FilePolicy = { mode: "allow", extensions: ["pdf"] };
  assert.equal(isFileAllowed("Makefile", policy), false);
});

test("a blocklist permits a file with no extension", () => {
  const policy: FilePolicy = { mode: "block", extensions: ["exe"] };
  assert.equal(isFileAllowed("Makefile", policy), true);
});

test("an empty blocklist permits everything; an empty allowlist permits nothing", () => {
  assert.equal(isFileAllowed("setup.exe", { mode: "block", extensions: [] }), true);
  assert.equal(isFileAllowed("holiday.jpg", { mode: "allow", extensions: [] }), false);
});

// ---------------------------------------------------------------------------
// The receiving side
// ---------------------------------------------------------------------------

test("isExecutable does not follow the operator's policy", () => {
  // An operator who ALLOWS .exe has decided their instance may carry one --
  // not that somebody should be handed one with no warning.
  const permissive: FilePolicy = { mode: "block", extensions: [] };
  assert.equal(isFileAllowed("setup.exe", permissive), true);
  assert.equal(isExecutable("setup.exe"), true, "still warns");
  assert.equal(isExecutable("holiday.jpg"), false);
});

// ---------------------------------------------------------------------------
// The picker attribute
// ---------------------------------------------------------------------------

test("a blocklist has no accept expression -- which is why the rule is in code", () => {
  assert.equal(acceptAttribute(DEFAULT_FILE_POLICY), undefined);
});

test("an allowlist becomes a real accept attribute", () => {
  assert.equal(
    acceptAttribute({ mode: "allow", extensions: ["pdf", "png"] }),
    ".pdf,.png",
  );
  assert.equal(acceptAttribute({ mode: "allow", extensions: [] }), undefined);
});

// ---------------------------------------------------------------------------
// Rendering a name
// ---------------------------------------------------------------------------

test("a right-to-left override cannot disguise the displayed name", () => {
  // U+202E before "gnp.exe" renders as though the name ends in .png.
  const spoofed = `photo\u202Egnp.exe`;
  const shown = displayFileName(spoofed);
  assert.ok(!shown.includes("\u202E"));
  assert.equal(shown, "photognp.exe");
  // The extension check was never fooled either way.
  assert.equal(fileExtension(spoofed), "exe");
});

test("control characters cannot push text out of view", () => {
  assert.equal(displayFileName("report\n\n\n     .pdf"), "report     .pdf".trim());
  assert.equal(displayFileName("a\u0000b.txt"), "ab.txt");
  assert.equal(displayFileName("  spaced.txt  "), "spaced.txt");
});

test("an ordinary name is untouched, including non-Latin scripts", () => {
  assert.equal(displayFileName("отчёт.pdf"), "отчёт.pdf");
  assert.equal(displayFileName("報告書.pdf"), "報告書.pdf");
  assert.equal(displayFileName("report (1).pdf"), "report (1).pdf");
});
