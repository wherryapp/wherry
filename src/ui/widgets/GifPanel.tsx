// The GIF picker.
//
// ---------------------------------------------------------------------------
// What happens when one is tapped, and why
// ---------------------------------------------------------------------------
//
// It is downloaded here, on this device, and handed to the composer as an
// ordinary File -- the same thing a paste or a drop produces. From there it
// takes the path every photo already takes: re-encode (skipped for GIFs),
// seal with a single-use key, upload, and a reference in the payload.
//
// The alternative -- put the GIF's URL in the message and let each recipient
// load it -- is cheaper for us and much worse for them. Every recipient's
// device would fetch from the library's CDN when they opened the
// conversation, handing a third party their IP address and the time they read
// it: a read receipt, delivered to somebody who is not in the conversation, in
// a sealed conversation. Their network sees the hostname too. And the library
// could change or remove the file afterwards, so `message_archive` would stop
// being a record of what was actually sent.
//
// Sending the bytes costs roughly what one photo costs (the server picks
// renditions under 3 MB, against a 25 MB limit and a 2 GB quota), and photos
// already work exactly this way. So the expensive-looking option is the one
// that keeps the guarantee.
//
// The person who opens THIS panel is a different case, and is not protected:
// the thumbnails below load straight from the library's CDN, so opening the
// picker shows that CDN this device's address. That is why the panel is a
// deliberate tap rather than something that opens on its own, and it is
// recorded in docs/data-inventory.md.

import { useEffect, useRef, useState } from "react";

import { ApiError, fetchTrendingGifs, searchGifs, type Gif } from "../../api/client";
import { ErrorText, Input, LoadingLine, Note } from "../kit";
import { canDownloadGif, fileForGif } from "./gif-intake";
import type { WidgetContext } from "./WidgetBar";

/**
 * A sanity ceiling on a downloaded GIF, not the attachment limit.
 *
 * The server only ever hands out renditions under 3 MB, so this should never
 * bind -- it is here to catch a CDN answering with something unexpected
 * rather than to enforce policy. The authoritative check is `prepareForUpload`
 * at send time, against the account's real limit from the server.
 */
const SANITY_MAX_BYTES = 8 * 1024 * 1024;

/** Long enough that typing a word is one search, short enough to feel live. */
const DEBOUNCE_MS = 350;

export function GifPanel({ context }: { context: WidgetContext }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Gif[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // Focused on open. On a phone this keeps the keyboard up rather than
  // letting it close and reopen -- the panel is anchored just above the
  // composer, so a keyboard that closes would drop the whole panel down the
  // screen and then jerk it back.
  useEffect(() => {
    search.current?.focus();
  }, []);

  // The search itself: debounced, and cancelled when the query moves on.
  //
  // The abort matters more than the debounce. Without it, results arrive in
  // whatever order the network returns them, and a slow response to "ca" can
  // land after a fast one to "cats" and replace it -- the grid showing
  // something other than what the field says.
  useEffect(() => {
    const trimmed = query.trim();
    const controller = new AbortController();

    const run = (): void => {
      setError(null);
      const request =
        trimmed.length === 0
          ? fetchTrendingGifs(controller.signal)
          : searchGifs(trimmed, controller.signal);

      void request
        .then(({ results: found }) => {
          if (controller.signal.aborted) return;
          setResults(found);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          // An abort is a deliberate cancellation, not a failure.
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setResults([]);
          setError(
            cause instanceof ApiError && cause.status === 503
              ? "GIFs are not available right now."
              : "Could not reach the GIF library.",
          );
        });
    };

    // Trending loads immediately; typing waits. Debouncing the first load
    // would mean an empty panel for a third of a second every time it opens.
    if (trimmed.length === 0) {
      run();
      return () => controller.abort();
    }

    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function pick(gif: Gif): Promise<void> {
    if (picking !== null) return;

    const choice = {
      id: gif.id,
      title: gif.title,
      byteSize: gif.full.byteSize,
      width: gif.full.width,
      height: gif.full.height,
    };

    // Checked against the library's own stated size before spending the
    // download, so a refusal is immediate rather than arriving after a wait.
    const refusal = canDownloadGif(choice, SANITY_MAX_BYTES);
    if (refusal) {
      setError(refusal.reason);
      return;
    }

    setPicking(gif.id);
    setError(null);
    try {
      // Straight to the CDN. `no-referrer` so the URL of the page this is
      // sent from is not passed along with the request -- the CDN needs the
      // GIF's address, not ours.
      const response = await fetch(gif.full.url, { referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error(String(response.status));

      const file = fileForGif(await response.blob(), choice, SANITY_MAX_BYTES);
      if ("reason" in file) {
        setError(file.reason);
        return;
      }

      // Into the composer's one funnel, exactly like a paste or a drop. It
      // becomes a pending attachment rather than sending on its own: that
      // keeps one send button for everything, lets somebody put words with
      // it, and means a mis-tap is undone by removing a thumbnail instead of
      // by retracting a message.
      context.attach([file]);
      context.close();
    } catch {
      setError("That GIF could not be downloaded.");
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <div className="p-2">
        <Input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIFs"
          aria-label="Search GIFs"
          // The panel closes on Escape (WidgetBar owns that); stopping the
          // key here would trap somebody inside a field they cannot leave.
          enterKeyHint="search"
        />
      </div>

      {error && <ErrorText className="px-3 pb-2">{error}</ErrorText>}

      <div className="max-h-64 overflow-y-auto px-2 pb-2">
        {results === null && <LoadingLine className="m-2" />}

        {results !== null && results.length === 0 && !error && (
          <Note className="p-3">No GIFs found.</Note>
        )}

        {results !== null && results.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                // Same reason as every other control down here: pressing it
                // must not take the caret out of the composer.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void pick(gif)}
                disabled={picking !== null}
                className="relative aspect-square overflow-hidden rounded-lg bg-neutral-100 transition disabled:opacity-50 dark:bg-neutral-800"
              >
                <img
                  src={gif.preview.url}
                  // The library's own title, which is often empty. An empty
                  // alt is correct for a decorative tile; the button's own
                  // accessible name comes from the title attribute below.
                  alt=""
                  title={gif.title}
                  loading="lazy"
                  // Referrer withheld here too -- the grid is dozens of
                  // requests, and every one of them would otherwise carry
                  // the address of the page it was loaded from.
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
                {picking === gif.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-neutral-950/50 text-xs text-white">
                    Adding…
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Attribution is a condition of the library's terms, not decoration.
          Text rather than their supplied mark: shipping the logo would mean
          an image asset, and the terms accept an attribution line. If this
          ever goes near an app store listing, check whether the mark itself
          is required -- see docs/changelog.md. */}
      <div className="border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <Note>Powered by GIPHY</Note>
      </div>
    </div>
  );
}
