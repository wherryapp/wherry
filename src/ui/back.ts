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
// The arithmetic here is the part that goes wrong, so it is a pure class
// over a tiny history interface (back.test.ts), with the singleton below
// binding it to the real one.

import { useEffect, useRef } from "react";

/** The half of `window.history` this needs, so a test can supply its own. */
export interface HistoryLike {
  pushState(state: unknown, unused: string): void;
  back(): void;
}

interface Layer {
  readonly id: number;
  readonly close: () => void;
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

  // A plain field rather than a parameter property: `erasableSyntaxOnly` is
  // on, and that syntax emits code rather than erasing to nothing.
  constructor(history: HistoryLike) {
    this.#history = history;
  }

  /**
   * Registers a layer as the topmost thing a back press should dismiss.
   * Returns the release function for when it closes some other way -- a
   * close button, Escape, a tap on the backdrop.
   */
  push(close: () => void): () => void {
    const layer: Layer = { id: this.#nextId++, close };
    this.#layers.push(layer);
    this.#sync();
    return () => this.#release(layer);
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
    return true;
  }

  /** Layers currently registered. For the tests. */
  get depth(): number {
    return this.#layers.length;
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
// The singleton, bound to the real history
// ---------------------------------------------------------------------------

let shared: BackStack | null = null;

function stack(): BackStack {
  if (!shared) {
    shared = new BackStack(window.history);
    window.addEventListener("popstate", () => {
      shared?.onPopState();
    });
  }
  return shared;
}

/**
 * Registers `close` as what a back press should do, and returns the
 * release function. Outside a browser (the tsx test runner) this is a
 * no-op, the way the rest of the ui/ helpers are.
 */
export function pushBackLayer(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  return stack().push(close);
}

/**
 * Makes an open layer the back gesture's target for as long as `active`.
 *
 * `close` is read through a ref so that a caller re-rendering with a fresh
 * closure -- which is every caller, since these are inline arrows -- does
 * not tear the history entry down and push a new one on every render.
 */
export function useBackLayer(active: boolean, close: () => void): void {
  const latest = useRef(close);
  // Updated in an effect rather than during render: declared first, so it
  // runs before the effect below on every commit, and a back press can only
  // arrive between commits anyway.
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!active) return;
    return pushBackLayer(() => latest.current());
  }, [active]);
}
