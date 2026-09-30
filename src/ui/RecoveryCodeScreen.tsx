import { useState } from "react";
import { AuthShell, Button } from "./kit";

/**
 * The one and only display of a recovery code: after registration, after a
 * recovery (which mints a new code), and after Settings' "new recovery code".
 *
 * It is never stored, never mailed, never shown again -- so this screen
 * blocks until the person says they have it. No clipboard button,
 * deliberately: a code in the clipboard outlives this screen in a place other
 * apps can read, and the medium this is designed for is paper.
 *
 * `replacesOld` is Settings' case, where a working code existed a moment
 * ago: the screen says in its first sentence that that one is dead, because
 * somebody who has the old one in a drawer needs to know it no longer helps.
 */
export function RecoveryCodeScreen({
  code,
  onDone,
  replacesOld = false,
}: {
  code: string;
  onDone: () => void;
  replacesOld?: boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <AuthShell>
        <div>
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {replacesOld ? "Your new recovery code" : "Your recovery code"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {replacesOld &&
              "Your previous recovery code no longer works. "}
            If you ever reset your password, this code is what brings your
            message history back. Write it down somewhere safe — not in an
            email, not in a screenshot.
          </p>
        </div>

        <p className="select-all rounded-md bg-neutral-100 px-3 py-3 text-center font-mono text-sm tracking-wide text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
          {code}
        </p>

        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This is the only time it will be shown. Nobody — including the
          server — can recover it for you.
        </p>

        <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have written this code down.</span>
        </label>

        <Button
          type="button"
          disabled={!acknowledged}
          onClick={onDone}
          className="w-full"
        >
          Continue
        </Button>
    </AuthShell>
  );
}
