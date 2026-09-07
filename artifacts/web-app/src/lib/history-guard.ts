import { useSyncExternalStore } from "react";
import { navigate } from "wouter/use-browser-location";
import type { BaseLocationHook } from "wouter";

/**
 * Browser-history support for unsaved-change protection (Batch 17).
 *
 * 1. History index — every same-document history entry the app creates is
 *    stamped with a monotonically increasing index in `history.state`
 *    (`__lcpHistoryIndex`). Wouter already monkey-patches `pushState` /
 *    `replaceState` and dispatches same-named window events, so a new entry is
 *    stamped right after it is created and an entry visited via popstate
 *    reports its own index. A guard can therefore turn a Back/Forward popstate
 *    into an exact delta (target − editor entry), move the pointer straight
 *    back with `history.go(-delta)` and, on discard, replay `history.go(delta)`.
 *    No entries are ever added or removed, so there are no phantom entries.
 *
 * 2. Guarded location hook — `history.go()` is asynchronous and React renders
 *    the popped URL synchronously from wouter's own subscription, which would
 *    unmount the editor before the revert lands. `useGuardedBrowserLocation`
 *    replaces the default location hook (`<Router hook={…}>`): it keeps ONE
 *    capture-phase popstate listener per document that runs the registered
 *    guard handlers first and only then notifies React, and it reports a held
 *    ("frozen") path while a guard asks for it. `navigate`, `base`, `useSearch`
 *    and `useParams` behave exactly as before; nothing is held when no guard is
 *    active.
 */

const INDEX_KEY = "__lcpHistoryIndex";
const EVENT_PUSH = "pushState";
const EVENT_REPLACE = "replaceState";

// ── history index ───────────────────────────────────────────────────────────

let indexInstalled = false;
let index = 0;

export function historyIndexOf(state: unknown): number | null {
  if (state && typeof state === "object") {
    const v = (state as Record<string, unknown>)[INDEX_KEY];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function stampCurrentEntry() {
  const s = window.history.state as unknown;
  // Leave a foreign primitive state untouched — such an entry simply reports no index.
  if (s !== null && s !== undefined && typeof s !== "object") return;
  if (historyIndexOf(s) === index) return;
  window.history.replaceState({ ...((s as Record<string, unknown> | null | undefined) ?? {}), [INDEX_KEY]: index }, "", window.location.href);
}

/** Idempotent. Runs at module load so the very first entry is stamped before any navigation. */
export function installHistoryIndex() {
  if (indexInstalled || typeof window === "undefined") return;
  indexInstalled = true;
  // A reload keeps `history.state`, so adopt an existing stamp instead of restarting at 0.
  index = historyIndexOf(window.history.state) ?? 0;
  stampCurrentEntry();
  window.addEventListener(EVENT_PUSH, () => {
    index += 1;
    stampCurrentEntry();
  });
  // A replace that dropped the stamp (navigate(..., { replace: true, state })) gets it back.
  window.addEventListener(EVENT_REPLACE, stampCurrentEntry);
  window.addEventListener(
    "popstate",
    (e: PopStateEvent) => {
      const i = historyIndexOf(e.state);
      if (i != null) index = i;
    },
    true,
  );
}

export function currentHistoryIndex(): number {
  return index;
}

// ── guarded location store ──────────────────────────────────────────────────

type PopStateHandler = (e: PopStateEvent) => void;
const popStateHandlers = new Set<PopStateHandler>();
const reactSubscribers = new Set<() => void>();
let listening = false;
let heldPath: string | null = null;

function notifyReact() {
  for (const cb of Array.from(reactSubscribers)) cb();
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // Capture phase on the window target: runs before wouter's / any bubble listener.
  window.addEventListener(
    "popstate",
    (e: Event) => {
      for (const handler of Array.from(popStateHandlers)) handler(e as PopStateEvent);
      notifyReact();
    },
    true,
  );
  for (const ev of [EVENT_PUSH, EVENT_REPLACE, "hashchange"]) window.addEventListener(ev, notifyReact);
}

/** Register a popstate handler that runs BEFORE the router learns about the traversal. */
export function addGuardedPopStateHandler(handler: PopStateHandler): () => void {
  ensureListening();
  popStateHandlers.add(handler);
  return () => {
    popStateHandlers.delete(handler);
  };
}

/** Hold the router on `path` (absolute pathname, including the base) or release it with `null`. */
export function holdLocation(path: string | null) {
  if (heldPath === path) return;
  heldPath = path;
  notifyReact();
}

export function heldLocation(): string | null {
  return heldPath;
}

function subscribeLocation(cb: () => void) {
  ensureListening();
  reactSubscribers.add(cb);
  return () => {
    reactSubscribers.delete(cb);
  };
}
const getPath = () => heldPath ?? window.location.pathname;

/** Drop-in replacement for wouter's default location hook: `<Router hook={useGuardedBrowserLocation}>`. */
export const useGuardedBrowserLocation: BaseLocationHook = (opts?: { ssrPath?: string }) => {
  const path = useSyncExternalStore(subscribeLocation, getPath, () => opts?.ssrPath ?? "/");
  return [path, navigate];
};

installHistoryIndex();
