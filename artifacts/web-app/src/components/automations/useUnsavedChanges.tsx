import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { addGuardedPopStateHandler, currentHistoryIndex, historyIndexOf, holdLocation, installHistoryIndex } from "@/lib/history-guard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export type PendingNavigation =
  | { kind: "href"; href: string }
  /** A browser Back/Forward (history traversal) of `delta` entries that was held back. */
  | { kind: "history"; delta: number };

/**
 * Unsaved-change protection for the automation editor:
 *  • the browser "leave page?" prompt on reload / tab close (beforeunload);
 *  • every in-app link click while dirty is intercepted (document capture
 *    phase, before wouter's Link handler) and routed through a confirm dialog;
 *  • `requestNavigation(href)` gives the page's own Back/Cancel buttons the
 *    same behaviour;
 *  • browser Back/Forward: the `popstate` is answered by moving the history
 *    pointer straight back onto the editor entry (`history.go(-delta)`, delta
 *    from the stamped history index) while the router is held on the editor
 *    path so nothing unmounts; "Discard" replays exactly that traversal
 *    (`history.go(delta)`), "Stay" simply keeps the already-restored state.
 *    No history entries are added or removed at any point.
 * Nothing is intercepted when the editor is clean; every listener is removed
 * when the editor becomes clean again or unmounts.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const [, setLocation] = useLocation();
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const replayRef = useRef<((delta: number) => void) | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const next = url.pathname + url.search + url.hash;
      const current = window.location.pathname + window.location.search + window.location.hash;
      if (next === current) return;
      e.preventDefault();
      e.stopPropagation();
      setPending((p) => p ?? { kind: "href", href: next });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    installHistoryIndex();
    // The editor's own history entry: where every held-back traversal is returned to.
    const home = { index: currentHistoryIndex(), path: window.location.pathname };
    let replaying = false;

    const onPopState = (e: PopStateEvent) => {
      const landed = historyIndexOf(e.state);
      if (replaying) {
        // The discarded traversal completed. The route normally changes now and this
        // guard unmounts; if the same editor instance stays mounted, re-home on the new entry.
        replaying = false;
        home.index = landed ?? home.index;
        home.path = window.location.pathname;
        holdLocation(null);
        return;
      }
      if (landed === home.index) {
        // Back on the editor entry: our revert landed (or the entry only changed its hash).
        holdLocation(null);
        return;
      }
      // An entry without a stamp can only come from outside the app's own history; treat it as Back.
      const delta = landed == null ? -1 : landed - home.index;
      // Hold the router on the editor while the pointer travels back, then ask.
      holdLocation(home.path);
      setPending((p) => p ?? { kind: "history", delta });
      window.history.go(-delta);
    };

    replayRef.current = (delta: number) => {
      replaying = true;
      holdLocation(null);
      window.history.go(delta);
    };
    const removePopState = addGuardedPopStateHandler(onPopState);
    return () => {
      removePopState();
      replayRef.current = null;
      holdLocation(null);
    };
  }, [dirty]);

  const go = useCallback(
    (href: string) => {
      let path = href;
      if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || "/";
      setLocation(path);
    },
    [setLocation],
  );

  const requestNavigation = useCallback(
    (href: string) => {
      if (!dirty) {
        go(href);
        return;
      }
      setPending((p) => p ?? { kind: "href", href });
    },
    [dirty, go],
  );

  const confirm = useCallback(() => {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "href") go(p.href);
    else replayRef.current?.(p.delta);
  }, [pending, go]);

  const cancel = useCallback(() => setPending(null), []);

  return { pending, requestNavigation, confirm, cancel };
}

export function UnsavedChangesDialog({ open, onCancel, onDiscard }: { open: boolean; onCancel: () => void; onDiscard: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This automation has changes that have not been saved. Leave the page and lose them, or stay and save first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="unsaved-stay">Stay</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="unsaved-discard" onClick={onDiscard}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
