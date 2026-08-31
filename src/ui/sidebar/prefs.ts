// Device-local sidebar layout preferences (split height, collapsed hubs,
// manual hub order), persisted in the IndexedDB meta store under
// META_SIDEBAR_PREFS. This deliberately does NOT follow the hooks.ts
// pattern of re-reading on sync events: no sync event fires for a local
// write, so the hook owns its own invalidation -- a module-level cache and
// listener set, updated synchronously on write with the IndexedDB put
// trailing behind as a write-through. A failed write costs a preference,
// never the UI; cross-tab agreement is deliberately not attempted (each
// tab reads once at load, and two tabs disagreeing about a panel height
// until reload is fine).

import { useCallback, useSyncExternalStore } from "react";
import { store } from "../../store";
import { META_SIDEBAR_PREFS, type SidebarPrefs } from "../../store/types";

const DEFAULT_PREFS: SidebarPrefs = {
  hubsHeightPx: null,
  collapsedHubIds: [],
  hubOrder: [],
};

let cache: SidebarPrefs | null = null;
let loadStarted = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (!loadStarted) {
    loadStarted = true;
    // Merge over the defaults so a preference field added later reads as
    // its default instead of undefined on stores written before it existed.
    store
      .getMeta<SidebarPrefs>(META_SIDEBAR_PREFS)
      .then((stored) => {
        cache = { ...DEFAULT_PREFS, ...stored };
        listeners.forEach((l) => l());
      })
      .catch(() => {
        cache = { ...DEFAULT_PREFS };
        listeners.forEach((l) => l());
      });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): SidebarPrefs {
  return cache ?? DEFAULT_PREFS;
}

export function useSidebarPrefs(): {
  prefs: SidebarPrefs;
  update: (patch: Partial<SidebarPrefs>) => void;
} {
  const prefs = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((patch: Partial<SidebarPrefs>) => {
    cache = { ...(cache ?? DEFAULT_PREFS), ...patch };
    listeners.forEach((l) => l());
    void store.setMeta(META_SIDEBAR_PREFS, cache).catch(() => {});
  }, []);
  return { prefs, update };
}
