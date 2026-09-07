import { useCallback, useEffect, useState } from "react";
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

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Unsaved-change protection for the automation editor:
 *  • the browser "leave page?" prompt on reload / tab close (beforeunload);
 *  • every in-app link click while dirty is intercepted (document capture
 *    phase, before wouter's Link handler) and routed through a confirm dialog;
 *  • `requestNavigation(href)` gives the page's own Back/Cancel buttons the
 *    same behaviour.
 * Nothing is intercepted when the editor is clean.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const [, setLocation] = useLocation();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

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
      setPendingHref(next);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
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
      setPendingHref(href);
    },
    [dirty, go],
  );

  const confirm = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    if (href) go(href);
  }, [pendingHref, go]);

  const cancel = useCallback(() => setPendingHref(null), []);

  return { pendingHref, requestNavigation, confirm, cancel };
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
