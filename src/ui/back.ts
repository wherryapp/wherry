// The back gesture, as a stack of dismissible layers.
//
// Android's back button and back swipe are that platform's primary way out
// of anything, and in a webview they arrive as history navigation and
// nothing else: wry's WryActivity asks `webView.canGoBack()` and, when the
// answer is no, finishes the activity. This app is one screen with panels
// and no router, so the answer was always no -- pressing back inside a
// conversation, a photo, a settings panel or an open profile card quit the
// app outright. That is the single largest gap between the Android shell
// and a native app.
//
// So the layers put their own entries on the history stack. A layer that
// opens pushes one; a back press pops it and the page closes the topmost
// layer instead of the activity closing; with nothing open the entry stack
// is empty, `canGoBack()` is false again, and back quits the app, which is
// what Android users expect at the top of an app.
//
// Deliberately not gated on the shell, and not on a user agent. The
// mechanism is history, which every browser has, and the behaviour it
// produces is the right one everywhere: browser-back closing the open
// modal rather than leaving the site is what the web does too, and it is
// the same code on the desktop app (where nothing can trigger it) as on
// the phone. Gating would mean a second behaviour to reason about for no
// gain -- see CLAUDE.md on deciding by capability rather than platform.
//
// **Escape follows the same stack.** It is the keyboard's back, and it had
// been wired per layer instead: each surface listened for the key itself and
// told the others apart only by event phase -- Panel on the document's
// bubble, the call page on the window's, Popovers and dialogs in the
// capture phase with propagation stopped. Three phases cannot order more
// than three layers, and two of them were bubble listeners that did not
// stop anything, so one Escape with the call page open over Settings closed
// both (row W-103, 2026-09-26, both engines on the Windows rig), and one
// Escape on a confirm opened from a profile card closed both of those (two
// capture listeners on the same node, where stopPropagation stops neither).
// The stack already knows which layer is on top, because it is the stack a
// back press pops, so there is one keydown listener and it asks the stack:
// one press, the topmost layer, and nothing under it. A surface that wants
// Escape to close it registers with `useBackLayer` and listens for nothing.
//
// The arithmetic here is the part that goes wrong, so it is a pure class
// over a tiny history interface (back.test.ts), with the singleton below
// binding it to the real one.

import { useEffect, useRef, useSyncExternalStore } from "react";

/** The half of `window.history` this needs, so a test can supply its own. */
export interface HistoryLike {
  pushState(state: unknown, unused: string): void;
  back(): void;
}

/**
 * What Escape does when this layer is the topmost one.
 *
 * - `"close"`: closes it, exactly as a back press would. Every layer but two.
 * - `"outside-fields"`: closes it unless the key was pressed in a text field,
 *   where Escape belongs to the field. The phone's open conversation, whose
 *   composer usually has the caret: Escape there must not throw away the
 *   thread somebody is typing in.
 * - `"never"`: closes nothing -- *including whatever is under it*. The
 *   incoming-call sheet: back declines there, but Escape never ends a call
 *   (Chat.tsx: leaving a call is a deliberate click), and a modal sheet
 *   letting the key through would close the screen it is covering.
 */
export type EscapeRule = "close" | "outside-fields" | "never";

/**
 * What one Escape did. `"passed"` is "not ours" -- nothing open, or the top
 * layer leaves this key to the field it was pressed in -- and is the only
 * outcome the key is allowed to travel on from.
 */
export type EscapeOutcome = "closed" | "held" | "passed";

interface Layer {
  readonly id: number;
  readonly close: () => void;
  readonly escape: EscapeRule;
  /**
   * Drawn *over* the screen (a Popover, the photo viewer, a dialog, the
   * call page) rather than replacing it (a Settings panel, the phone's open
   * conversation). The distinction exists for one reader: a native video
   * tile sits above everything the page draws, so it must hide while an
   * overlay is above its surface -- and must *not* hide because somebody
   * opened Settings under the call bar. See `overlayDepth`.
   */
  readonly overlay: boolean;
}

/**
 * The marker put on our own history entries. Nothing reads it back --
 * entry *count* is what the stack tracks -- but it makes the entries
 * legible in a debugger, and identifies them if something ever needs to
 * tell ours from a real navigation.
 */
export const BACK_STATE_KEY = "wherryBackLayer";

export class BackStack {
  #layers: Layer[] = [];
  #nextId = 1;

  /**
   * How many history entries this stack believes it owns. Kept beside the
   * layers rather than derived from them because the two go out of step for
   * as long as a `back()` is in flight, and reconciling them is the whole
   * job of #sync.
   */
  #entries = 0;

  /**
   * True while our own `history.back()` has been called and its popstate
   * has not arrived yet.
   *
   * `history.back()` is asynchronous, and a layer closing and reopening
   * inside one tick is not exotic -- it is what React's development
   * double-invoke does to every effect. So rather than counting popstate
   * events to swallow, at most one back() is ever in flight and the next
   * popstate is unambiguously its own; everything else waits for it and is
   * reconciled afterwards.
   */
  #backInFlight = false;

  readonly #history: HistoryLike;
  readonly #listeners = new Set<() => void>();

  // A plain field rather than a parameter property: `erasableSyntaxOnly` is
  // on, and that syntax emits code rather than erasing to nothing.
  constructor(history: HistoryLike) {
    this.#history = history;
  }

  /**
   * Registers a layer as the topmost thing a back press should dismiss.
   * Returns the release function for when it closes some other way -- a
   * close button, a tap on the backdrop. `overlay` and `escape` are the
   * Layer fields of those names; the defaults are the common case.
   */
  push(
    close: () => void,
    overlay = true,
    escape: EscapeRule = "close",
  ): () => void {
    const layer: Layer = { id: this.#nextId++, close, overlay, escape };
    this.#layers.push(layer);
    this.#sync();
    this.#notify();
    return () => this.#release(layer);
  }

  /** Called whenever the set of layers changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /**
   * A popstate arrived. Returns whether it closed a layer, which only the
   * tests read -- the listener ignores the answer.
   */
  onPopState(): boolean {
    if (this.#backInFlight) {
      this.#backInFlight = false;
      this.#entries -= 1;
      this.#sync();
      return false;
    }
    // Somebody pressed back, and the browser has already spent one of our
    // entries getting here.
    this.#entries = Math.max(0, this.#entries - 1);
    const layer = this.#layers.pop();
    if (!layer) {
      this.#sync();
      return false;
    }
    layer.close();
    this.#sync();
    this.#notify();
    return true;
  }

  /**
   * Escape was pressed (see `countsAsEscape` for which presses count).
   * `inField` is whether it was pressed in a text field, which only an
   * `"outside-fields"` layer reads.
   *
   * A back press without the history: the topmost layer comes off *before*
   * its close() runs, the way onPopState does it, so the component's own
   * release on unmount finds it gone, and a second press -- even one that
   * lands before React has committed the first -- goes to the layer under
   * it rather than to the one already closing. The entry the layer owned is
   * then given back by #sync, the same way as any other close.
   */
  onEscape(inField: boolean): EscapeOutcome {
    const layer = this.#layers.at(-1);
    if (!layer) return "passed";
    if (layer.escape === "never") return "held";
    if (layer.escape === "outside-fields" && inField) return "passed";
    this.#layers.pop();
    layer.close();
    this.#sync();
    this.#notify();
    return "closed";
  }

  /** Layers currently registered. For the tests. */
  get depth(): number {
    return this.#layers.length;
  }

  /**
   * How many *overlay* layers are open (see `Layer.overlay`). A layer that
   * registered as an overlay when there were N of them is the (N+1)th, so
   * "is something above me" is `overlayDepth > N + 1` -- which is exactly
   * what the call page asks (`useBackLayer` hands N back).
   */
  get overlayDepth(): number {
    return this.#layers.filter((layer) => layer.overlay).length;
  }

  /** History entries currently believed owned. For the tests. */
  get entries(): number {
    return this.#entries;
  }

  #release(layer: Layer): void {
    const index = this.#layers.indexOf(layer);
    // Already gone: a back press popped it and called close(), and this is
    // the closing component's own cleanup arriving after.
    if (index === -1) return;
    this.#layers.splice(index, 1);
    this.#sync();
    this.#notify();
  }

  /**
   * Makes the number of history entries match the number of layers -- one
   * each, so that every back press has something of ours to spend and, once
   * nothing is open, the next one belongs to the platform (on Android, it
   * closes the app, which is right at the top of an app).
   *
   * Entries carry no meaning individually. Only the count matters, which is
   * why a released layer that was not the top still costs the newest entry:
   * which one goes is invisible.
   */
  #sync(): void {
    if (this.#backInFlight) return;
    while (this.#entries < this.#layers.length) {
      this.#entries += 1;
      this.#history.pushState({ [BACK_STATE_KEY]: this.#entries }, "");
    }
    if (this.#entries > this.#layers.length) {
      this.#backInFlight = true;
      this.#history.back();
    }
  }
}

// ---------------------------------------------------------------------------
// Which key presses are an Escape
// ---------------------------------------------------------------------------

/** The parts of a keydown the Escape decision reads, so a test can hand in
 *  a plain object. */
export interface EscapeKeyEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
}

/**
 * Whether a keydown is one Escape press for the stack to act on.
 *
 * - An auto-repeat is not another press. A held key would otherwise close
 *   layer after layer at the keyboard's repeat rate, which is several
 *   presses' worth from somebody who pressed once.
 * - A press during IME composition cancels the composition and nothing
 *   else.
 * - A press something else already claimed with `preventDefault` is
 *   theirs. Nothing here claims one today; it is the conventional way for a
 *   widget with its own use for the key -- a combobox closing its list --
 *   to keep it from also closing the layer it sits in. (Stopping the key's
 *   propagation does the same, since the listener is on the document.)
 */
export function countsAsEscape(event: EscapeKeyEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.repeat &&
    !event.isComposing &&
    !event.defaultPrevented
  );
}

/**
 * Whether a key's target is a text field, for an `"outside-fields"` layer.
 * Duck-typed so the tests need no DOM. The same three cases Chat.tsx's
 * thread Escape tested before it moved here.
 */
export function isTextEntry(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
}

// ---------------------------------------------------------------------------
// The singleton, bound to the real history and the real keyboard
// ---------------------------------------------------------------------------

let shared: BackStack | null = null;

function stack(): BackStack {
  if (!shared) {
    shared = new BackStack(window.history);
    window.addEventListener("popstate", () => {
      shared?.onPopState();
    });
    // The one Escape listener (see the header). Installed with the stack
    // because until a layer exists there is nothing for the key to close.
    // The document's bubble phase: a focused element's own handler --
    // React's included, which listen on the root below the document -- runs
    // first and can keep the key; a key the stack used stops here, before
    // anything on the window hears it.
    document.addEventListener("keydown", (event) => {
      if (!shared || !countsAsEscape(event)) return;
      if (shared.onEscape(isTextEntry(event.target)) !== "passed") {
        event.stopPropagation();
      }
    });
  }
  return shared;
}

/**
 * Registers `close` as what a back press -- and an Escape, by `escape`'s
 * rule -- should do, and returns the release function. Outside a browser
 * (the tsx test runner) this is a no-op, the way the rest of the ui/
 * helpers are.
 */
export function pushBackLayer(
  close: () => void,
  overlay = true,
  escape: EscapeRule = "close",
): () => void {
  if (typeof window === "undefined") return () => {};
  return stack().push(close, overlay, escape);
}

/** Open overlay layers right now; 0 outside a browser. */
export function overlayDepth(): number {
  if (typeof window === "undefined") return 0;
  return stack().overlayDepth;
}

function subscribeStack(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  return stack().subscribe(listener);
}

/** `overlayDepth`, live: re-renders the caller when a layer opens or closes. */
export function useOverlayDepth(): number {
  return useSyncExternalStore(subscribeStack, overlayDepth, () => 0);
}

/**
 * Makes an open layer the back gesture's target -- and Escape's, by
 * `options.escape` (an `EscapeRule`; it closes by default) -- for as long as
 * `active`.
 *
 * `close` is read through a ref so that a caller re-rendering with a fresh
 * closure -- which is every caller, since these are inline arrows -- does
 * not tear the history entry down and push a new one on every render.
 *
 * Returns a ref whose `current` is, while the layer is open, how many
 * overlays were open *beneath* it when it registered (null when it is not
 * an overlay, or not open). A ref rather than state, because it is read in
 * effects that already re-run on `useOverlayDepth`, and setting state from
 * an effect would only add a render.
 */
export function useBackLayer(
  active: boolean,
  close: () => void,
  options: { overlay?: boolean; escape?: EscapeRule } = {},
): { readonly current: number | null } {
  const overlay = options.overlay ?? true;
  const escape = options.escape ?? "close";
  const latest = useRef(close);
  const position = useRef<number | null>(null);
  // Updated in an effect rather than during render: declared first, so it
  // runs before the effect below on every commit, and a back press can only
  // arrive between commits anyway.
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!active) return;
    position.current = overlay ? overlayDepth() : null;
    const release = pushBackLayer(() => latest.current(), overlay, escape);
    return () => {
      release();
      position.current = null;
    };
  }, [active, overlay, escape]);
  return position;
}
