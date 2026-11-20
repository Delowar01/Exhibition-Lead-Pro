import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AppState, Platform } from "react-native";

import {
  createContact,
  createScan,
  getScan,
  upsertOwnCard,
  type BusinessCardInput,
  type ContactInput,
  type ExtractedCardData,
} from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import i18n from "@/lib/i18n";

import { discardDamagedCopies, loadQueue, queueWritable, saveQueue, type QueueItem } from "@/lib/offline-queue";
import {
  canStartSync,
  discardQuarantined,
  enqueueItem,
  isTenantOwnerKey,
  makeQueueId,
  quarantinedCount as countQuarantined,
  queueCounts,
  queueOwnerKey,
  removeOwnedItem,
  resolveOwnedConflict,
  replacedBy,
  retryOwnedItem,
  syncOwnedQueue,
  visibleQueue,
  NO_AUTO_RETRY,
  autoSyncCandidates,
  planAutoRetry,
  repeatIsUnverifiable,
  retryDelayMs,
  type AutoRetryState,
  type QueueItemDraft,
  type QueueResolution,
  type SyncResult,
} from "@/lib/offline-queue-model";
import {
  enqueueFailureOf,
  planAdoption,
  rememberDone,
  restoredToProcess,
  type EnqueueResult,
  type QueueIncident,
} from "@/lib/offline-queue-store-model";
import { classifySyncFailure, createPerformer } from "@/lib/offline-sync";
import { PHOTO_READ_TIMEOUT_MS, RequestTimeoutError, SYNC_TIMEOUT_MS, withTimeout } from "@/lib/request-timeout";
import { scanFiles } from "@/lib/scan-file-driver";
import { ScanFileError } from "@/lib/scan-files";

const MANUAL_OFFLINE_KEY = "csp_offline_manual";

interface EnqueueMeta {
  label: string;
  source: string;
  /**
   * The account that MADE the capture — `captureOwner()` read before the first
   * request for it was sent. A capture that is kept only after that request
   * failed is stored for this account, whoever is signed in by then (it then
   * waits, invisible, until its account signs in again). Without it the
   * account signed in at the moment of keeping is used.
   */
  owner?: string | null;
  /**
   * A request that creates this contact was already sent and its answer was
   * lost (no connection, time-out, server error). Recorded so that a matching
   * contact found later is presented as "possibly this very capture".
   */
  answerLost?: boolean;
  appLanguage?: "en" | "ar";
  eventId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
}

/** The card was already read by the server before the capture had to be kept (only the contact is still missing). */
interface ScanProgress {
  scanId: number;
  extracted: ExtractedCardData | null;
}

/**
 * Something about the device's storage the user should know:
 *   • `write-failed`     — the last change to the queue could not be stored;
 *   • `index-unreadable` — the stored queue could not be read, so nothing is
 *     written in this session (what is stored is left exactly as it is);
 *   • `index-damaged-unsaved` — the stored queue is damaged AND its original
 *     could not be kept (no space, or earlier kept copies fill the places for
 *     them). Nothing is written in this session; nothing was changed.
 */
export type StorageProblem = "none" | "write-failed" | "index-unreadable" | "index-damaged-unsaved";

interface OfflineContextValue {
  /** True network reachability (ignores the manual override). */
  isConnected: boolean;
  /** User-controlled "work offline" override (device-wide). */
  manualOffline: boolean;
  /** Effective online state used by the app: connected AND not forced offline. */
  isOnline: boolean;
  /** The signed-in account's own queued work — never another account's. */
  queue: QueueItem[];
  /** Items still waiting to sync (pending + syncing), this account only. */
  pendingCount: number;
  failedCount: number;
  /** Captures that match an existing contact and wait for the user's decision. */
  conflictCount: number;
  /** Everything of this account (pending + syncing + failed + conflicts). */
  queuedCount: number;
  /** Items from an older app version (no ownership) kept quarantined on the device; count only. */
  legacyCount: number;
  isSyncing: boolean;
  lastSyncAt: number | null;
  /** Why the last sync run could not finish (lib/offline-sync.ts `syncProblemKey` kinds), or null. */
  syncNotice: string | null;
  storageProblem: StorageProblem;
  /** The queue of an older app version exists on this device but cannot be read. It is kept. */
  legacyUnreadable: boolean;
  /** Scans restored in this session from photos the queue no longer listed. */
  recoveredCount: number;
  /**
   * The record of the list of pending captures having been found damaged (null
   * = never). The Sync Center reports it — what was read back, what could not
   * be, that the original is kept — until the user removes the kept copies.
   */
  incident: QueueIncident | null;
  /** The user's own, confirmed decision to remove the kept originals of a damaged list. */
  discardDamagedCopies: () => Promise<void>;
  setManualOffline: (value: boolean) => void;
  /**
   * Keep a capture on the device. Resolves `{ ok: true }` only once it is
   * stored; `{ ok: false, reason }` means it was NOT kept and the caller must
   * tell the user (lib/offline-queue-store-model.ts `enqueueFailureKeys`).
   */
  /**
   * The tenant account signed in right now (null = none). A screen reads it
   * BEFORE sending a capture and hands it back in `meta.owner` if the capture
   * must be kept afterwards.
   */
  captureOwner: () => string | null;
  enqueueContact: (payload: ContactInput, meta: EnqueueMeta) => Promise<EnqueueResult>;
  enqueueScan: (imageData: string | null, meta: EnqueueMeta, progress?: ScanProgress) => Promise<EnqueueResult>;
  enqueueCard: (payload: BusinessCardInput, label: string) => Promise<EnqueueResult>;
  syncNow: () => void;
  retryItem: (id: string) => void;
  removeItem: (id: string) => void;
  /** The user's decision for a capture that matches an existing contact. */
  resolveConflict: (id: string, mode: QueueResolution["mode"]) => void;
  /** Explicitly drop the quarantined legacy items (they are never adopted or synced). */
  discardLegacyItems: () => void;
}

const NOT_READY: EnqueueResult = { ok: false, reason: "no-owner" };

const OfflineContext = createContext<OfflineContextValue>({
  isConnected: true,
  manualOffline: false,
  isOnline: true,
  queue: [],
  pendingCount: 0,
  failedCount: 0,
  conflictCount: 0,
  queuedCount: 0,
  legacyCount: 0,
  isSyncing: false,
  lastSyncAt: null,
  syncNotice: null,
  storageProblem: "none",
  legacyUnreadable: false,
  recoveredCount: 0,
  incident: null,
  discardDamagedCopies: async () => {},
  setManualOffline: () => {},
  captureOwner: () => null,
  enqueueContact: async () => NOT_READY,
  enqueueScan: async () => NOT_READY,
  enqueueCard: async () => NOT_READY,
  syncNow: () => {},
  retryItem: () => {},
  removeItem: () => {},
  resolveConflict: () => {},
  discardLegacyItems: () => {},
});

/** What the user is told after a run that could not finish (null = nothing to report). */
function noticeOf(result: SyncResult): string | null {
  if (result.stopped === "storage") return "storage";
  if (result.stopped === "auth") return "session_expired";
  if (result.stopped === "rate-limited") return "rate_limited";
  if (result.stopped === "offline" && result.reasonKind === "network") return "network";
  if (result.deferred > 0 && result.reasonKind) return result.reasonKind;
  return null;
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // The account that owns new work and may see / sync existing work:
  // undefined until auth resolves, null when logged out or not a tenant user.
  const { user, isLoading: authLoading, endedOwner } = useAuth();
  const owner = authLoading ? undefined : queueOwnerKey(user);
  const ownerRef = useRef<string | null | undefined>(owner);
  ownerRef.current = owner;
  // Every persisted item (all owners + quarantined); only `owner`'s subset is exposed.
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isConnected, setIsConnected] = useState(true);
  const [manualOffline, setManualOfflineState] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [storageProblem, setStorageProblem] = useState<StorageProblem>("none");
  const [legacyUnreadable, setLegacyUnreadable] = useState(false);
  const [recoveredCount, setRecoveredCount] = useState(0);
  const [incident, setIncident] = useState<QueueIncident | null>(null);
  const incidentRef = useRef<QueueIncident | null>(null);
  // Photos made up to this time whose entry is missing wait for the user (0 = none).
  const holdBeforeRef = useRef(0);

  // Refs mirror the latest state so the (long-lived) sync loop never works off
  // a stale closure while items are being mutated mid-flight.
  const queueRef = useRef<QueueItem[]>([]);
  // Ids already uploaded or removed (stored with the queue): an image file left
  // behind for one of them is cleaned up, never taken for a new scan.
  const doneRef = useRef<string[]>([]);
  // Ids of captures whose image is written but whose queue entry is not stored yet.
  const inFlightRef = useRef<Set<string>>(new Set());
  const syncingRef = useRef(false);
  const isOnline = isConnected && !manualOffline;
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // Nothing is written before the stored queue is known: a capture made in the
  // first moments after launch waits for the load instead of replacing it.
  const hydration = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!hydration.current) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    hydration.current = { promise, resolve };
  }

  /** Publish the next queue and store it. Resolves true only when the device stored it. */
  const commit = useCallback(async (next: QueueItem[]): Promise<boolean> => {
    queueRef.current = next;
    setQueue(next);
    const stored = await saveQueue(next, doneRef.current);
    if (stored) setStorageProblem((p) => (p === "write-failed" ? "none" : p));
    else setStorageProblem((p) => (queueWritable() ? "write-failed" : p === "index-damaged-unsaved" ? p : "index-unreadable"));
    return stored;
  }, []);

  // --- Load persisted queue + manual flag once. -----------------------------
  useEffect(() => {
    let mounted = true;
    void (async () => {
      // Ownership, "syncing" → pending normalization, the take-over of an older
      // version's queue and the move of its images into files all happen here.
      const [stored, manual] = await Promise.all([
        loadQueue(scanFiles),
        AsyncStorage.getItem(MANUAL_OFFLINE_KEY).catch(() => null),
      ]);
      if (!mounted) return;
      queueRef.current = stored.items;
      doneRef.current = stored.doneIds;
      setQueue(stored.items);
      setStorageProblem(stored.writable ? "none" : stored.damagedCopyFailed ? "index-damaged-unsaved" : "index-unreadable");
      incidentRef.current = stored.incident;
      holdBeforeRef.current = stored.holdUnlistedBefore;
      setIncident(stored.incident);
      setLegacyUnreadable(stored.legacyUnreadable);
      // Found damaged just now: say so at once, wherever the user is. The Sync
      // Center keeps the full report (what was read back, what was not, that
      // the original is kept) until the user has dealt with it.
      if (stored.indexDamaged || stored.indexLost) {
        const body = !stored.writable
          ? stored.damagedCopyFailed
            ? "sync.storageDamagedUnsavedBody"
            : "sync.storageUnreadableBody"
          : stored.indexLost
            ? "sync.lostAlertBody"
            : "sync.damagedAlertBody";
        Alert.alert(i18n.t(stored.indexLost ? "sync.lostTitle" : "sync.damagedTitle"), i18n.t(body));
      }
      setManualOfflineState(manual === "1");
      setHydrated(true);
      hydration.current?.resolve();
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // --- Connectivity detection. ----------------------------------------------
  useEffect(() => {
    let mounted = true;

    if (Platform.OS === "web") {
      const update = () => {
        if (mounted) setIsConnected(typeof navigator === "undefined" ? true : navigator.onLine);
      };
      update();
      if (typeof window !== "undefined") {
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
          mounted = false;
          window.removeEventListener("online", update);
          window.removeEventListener("offline", update);
        };
      }
      return () => {
        mounted = false;
      };
    }

    const probe = () => {
      void Network.getNetworkStateAsync()
        .then((state) => {
          if (mounted) setIsConnected(state.isInternetReachable ?? state.isConnected ?? true);
        })
        .catch(() => {
          /* assume online on probe failure */
        });
    };
    probe();
    const sub = Network.addNetworkStateListener((state) => {
      if (mounted) setIsConnected(state.isInternetReachable ?? state.isConnected ?? true);
    });
    // A connectivity change while the app was in the background may never be
    // delivered: ask again whenever the app comes back to the foreground.
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") probe();
    });
    return () => {
      mounted = false;
      sub.remove();
      appSub.remove();
    };
  }, []);

  // --- Sync engine (lib/offline-queue-model.ts + lib/offline-sync.ts). -----
  // The network work for one item runs under the session active at that
  // moment, which is why the engine re-checks the owner right before EVERY
  // request (also between the two requests of a scan).
  const perform = useMemo(
    () =>
      createPerformer({
        // Every request has a time limit: a stalled connection must not leave the sync standing.
        api: {
          createScan: (input) => withTimeout(SYNC_TIMEOUT_MS.createScan, (o) => createScan(input, o)),
          getScan: (id) => withTimeout(SYNC_TIMEOUT_MS.getScan, (o) => getScan(id, o)),
          createContact: (input) => withTimeout(SYNC_TIMEOUT_MS.createContact, (o) => createContact(input, o)),
          upsertOwnCard: (input) => withTimeout(SYNC_TIMEOUT_MS.upsertOwnCard, (o) => upsertOwnCard(input, o)),
        },
        // Reading the photo has a limit too: a read that hangs must not leave the item "being sent" for ever.
        loadImage: (item) =>
          withTimeout(PHOTO_READ_TIMEOUT_MS, () => scanFiles.loadImage(item.owner, item.imageFile ?? "")).catch((err: unknown) => {
            // Not a network matter: the device did not hand the photo over in time. Tried again later.
            if (err instanceof RequestTimeoutError) throw new ScanFileError("storage-unavailable", "photo read timed out");
            throw err;
          }),
        language: () => (i18n.language === "ar" ? "ar" : "en"),
      }),
    [],
  );

  // --- Automatic retries (rules: planAutoRetry in lib/offline-queue-model.ts). ---
  const autoRetryRef = useRef<AutoRetryState>(NO_AUTO_RETRY);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A run the user asked for while another one was under way: it starts when that one ends.
  const rerunRef = useRef(false);
  const runSyncRef = useRef<(force: boolean) => Promise<void>>(async () => {});

  const cancelAutoSync = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);
  const scheduleAutoSync = useCallback(
    (delayMs: number) => {
      cancelAutoSync();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void runSyncRef.current(false);
      }, delayMs);
    },
    [cancelAutoSync],
  );
  /** Start the run the user asked for during the previous one, right after it. */
  const scheduleForcedSync = useCallback(() => {
    cancelAutoSync();
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      void runSyncRef.current(true);
    }, 0);
  }, [cancelAutoSync]);
  useEffect(() => cancelAutoSync, [cancelAutoSync]);

  const runSync = useCallback(
    async (force: boolean) => {
      if (syncingRef.current) {
        if (force) rerunRef.current = true;
        return;
      }
      if (!isOnlineRef.current) return;
      // The stored queue could not be read in this session: nothing this run did
      // could be recorded, so it does not run (what is stored stays as it is).
      if (!queueWritable()) return;
      // Only a signed-in tenant account syncs, and only its own items. The owner
      // is captured here and re-read before every request inside the engine.
      const syncOwner = ownerRef.current;
      if (!canStartSync({ hydrated: true, owner: syncOwner })) return;

      const startedAt = Date.now();
      const auto = autoRetryRef.current;
      if (!force && startedAt < auto.rateHoldUntil) {
        // The server asked for a pause: wait for it instead of asking again.
        scheduleAutoSync(auto.rateHoldUntil - startedAt);
        return;
      }
      const holdScans = !force && startedAt < auto.aiHoldUntil;
      cancelAutoSync();

      syncingRef.current = true;
      setIsSyncing(true);
      let result: SyncResult | null = null;
      try {
        result = await syncOwnedQueue({
          owner: syncOwner,
          currentOwner: () => ownerRef.current,
          isOnline: () => isOnlineRef.current,
          getQueue: () => queueRef.current,
          setQueue: commit,
          perform,
          classify: classifySyncFailure,
          force,
          holdScans,
          onUploaded: (item) => {
            doneRef.current = rememberDone(doneRef.current, item.id);
          },
          onSynced: async (item) => {
            // The server has it: the photo is no longer needed on the device.
            if (item.imageFile) await scanFiles.deleteImage(item.owner, item.imageFile);
          },
        });
      } finally {
        syncingRef.current = false;
        setIsSyncing(false);
        setLastSyncAt(Date.now());
        if (result) {
          const sameAccount = ownerRef.current === syncOwner;
          if (sameAccount) {
            const notice = noticeOf(result);
            // Scans merely held back in this run: the explanation given earlier still applies.
            if (!(holdScans && notice === null && result.deferred > 0)) setSyncNotice(notice);
          }
          if (result.synced > 0) void queryClient.invalidateQueries();
          const plan = planAutoRetry(autoRetryRef.current, result, {
            remaining: sameAccount ? autoSyncCandidates(queueRef.current, syncOwner).length : 0,
            now: Date.now(),
            online: isOnlineRef.current,
            heldScans: holdScans,
          });
          autoRetryRef.current = plan.state;
          if (rerunRef.current && sameAccount) {
            rerunRef.current = false;
            scheduleForcedSync();
          } else {
            rerunRef.current = false;
            if (plan.nextInMs !== null) scheduleAutoSync(plan.nextInMs);
          }
        }
      }
    },
    [commit, perform, queryClient, scheduleAutoSync, scheduleForcedSync, cancelAutoSync],
  );
  runSyncRef.current = runSync;
  const syncNow = useCallback(() => runSync(false), [runSync]);

  // --- Auto-sync when we (re)gain connectivity. -----------------------------
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (isOnline && !wasOnline) {
      void syncNow();
    }
  }, [isOnline, syncNow]);

  // --- Sync when the app returns to the foreground. --------------------------
  // After a pause (screen off, another app) waiting items are tried again
  // without the user having to open the Sync Center. Failed items keep their
  // retry delay; nothing runs while offline or signed out.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncNow();
    });
    return () => sub.remove();
  }, [syncNow]);

  // --- Initial sync on launch / on login with a restored queue. --------------
  // The reconnect effect only fires on a false→true transition, so a relaunch
  // that starts online would otherwise leave restored items unsynced. Nothing
  // runs until the queue is hydrated AND auth has resolved to a tenant owner;
  // a launch while logged out syncs nothing, and a later login syncs only that
  // owner's items (once per owner change).
  const autoSyncedOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canStartSync({ hydrated, owner })) {
      if (owner === null) {
        autoSyncedOwnerRef.current = null;
        setSyncNotice(null); // a notice belongs to the account it was raised for
        cancelAutoSync();
        autoRetryRef.current = NO_AUTO_RETRY;
        rerunRef.current = false;
      }
      return;
    }
    if (autoSyncedOwnerRef.current === owner) return;
    autoSyncedOwnerRef.current = owner ?? null;
    // Another account than the one the last run was for: its notice and its waiting times do not apply.
    setSyncNotice(null);
    cancelAutoSync();
    autoRetryRef.current = NO_AUTO_RETRY;
    rerunRef.current = false;
    if (isOnlineRef.current) void syncNow();
  }, [hydrated, owner, syncNow, cancelAutoSync]);

  // --- Photos the queue does not list (once per signed-in account). ----------
  // A photo of THIS account that has no queue entry is either finished work
  // whose file was left behind (cleaned up) or a capture whose entry was lost
  // — an interrupted save, a damaged queue. The latter comes back as a waiting
  // scan of this same account. Other accounts' folders are not looked at.
  const adoptedOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated || !isTenantOwnerKey(owner) || !scanFiles.available()) return;
    // The stored queue could not be read in this session: its photos are NOT
    // "unlisted" — the list is merely unknown. They are left exactly as they are.
    if (!queueWritable()) return;
    if (adoptedOwnerRef.current === owner) return;
    adoptedOwnerRef.current = owner;
    void (async () => {
      // What an interrupted write left behind (never a photo, never a write still running).
      await scanFiles.cleanPartials(owner, Date.now()).catch(() => 0);
      const listed = new Set<string>([...queueRef.current.map((it) => it.id), ...inFlightRef.current]);
      const orphans = await scanFiles.findOrphans(owner, listed);
      if (orphans.length === 0) return;
      // What to do with them is decided by planAdoption (lib/offline-queue-store-model.ts):
      // leftovers of finished work are removed; the rest comes back as scans —
      // those from BEFORE the list was damaged or lost wait for the user and
      // are not sent by themselves.
      const plan = planAdoption({
        orphans,
        owner,
        doneIds: doneRef.current,
        presentIds: new Set<string>([...queueRef.current.map((it) => it.id), ...inFlightRef.current]),
        now: Date.now(),
        heldBefore: holdBeforeRef.current,
      });
      for (const o of plan.remove) await scanFiles.deleteImage(owner, o.file);
      if (ownerRef.current !== owner) return;
      // The queue may have changed while files were removed: never restore what is listed by now.
      const presentNow = new Set<string>([...queueRef.current.map((it) => it.id), ...inFlightRef.current]);
      const restored = plan.restore.filter((it) => !presentNow.has(it.id));
      if (restored.length === 0) return;
      await commit([...restored, ...queueRef.current]);
      // "Restored and will be processed" counts only what really is processed by itself.
      setRecoveredCount(restoredToProcess(restored));
      if (isOnlineRef.current && restoredToProcess(restored) > 0) void syncNow();
    })();
  }, [hydrated, owner, commit, syncNow]);

  const setManualOffline = useCallback((value: boolean) => {
    setManualOfflineState(value);
    void AsyncStorage.setItem(MANUAL_OFFLINE_KEY, value ? "1" : "0").catch(() => {});
  }, []);

  // Every enqueue stamps the item with the signed-in tenant owner; without one
  // nothing is kept. A capture that was already under way when the session
  // ended by itself is still kept for the account that made it (short grace
  // period, never after an explicit sign-out) — it waits, invisible, until that
  // account signs in again.
  //
  // A screen that sends a capture first and keeps it only when that failed
  // names the account that made it (`meta.owner`, read before the request). The
  // capture is then stored for THAT account, never for whoever signed in while
  // the request was under way.
  const enqueueOwner = useCallback(
    (capturedBy?: string | null): string | null => {
      if (capturedBy !== undefined && capturedBy !== null) return isTenantOwnerKey(capturedBy) ? capturedBy : null;
      const current = ownerRef.current;
      if (isTenantOwnerKey(current)) return current;
      const ended = endedOwner();
      return isTenantOwnerKey(ended) ? ended : null;
    },
    [endedOwner],
  );
  const captureOwner = useCallback((): string | null => {
    const current = ownerRef.current;
    return isTenantOwnerKey(current) ? current : null;
  }, []);

  /** Add one item and report whether the device really stored it. */
  const keep = useCallback(
    async (draft: QueueItemDraft, itemOwner: string, id: string): Promise<boolean> => {
      const before = queueRef.current;
      const next = enqueueItem(before, draft, itemOwner, Date.now(), id);
      if (!next) return false;
      // What this entry replaces (an earlier card edit of the same account) will
      // never be sent: it is recorded as finished in the same save, so nothing
      // — an older queue still on the device, for instance — can bring it back.
      const superseded = replacedBy(before, next).map((it) => it.id);
      for (const old of superseded) doneRef.current = rememberDone(doneRef.current, old);
      if (await commit(next)) {
        // Kept while online (sending it failed a moment ago): it is tried again
        // by itself, after a pause — not at once, and not only when the user
        // next opens the Sync Center. A run already planned is left as it is.
        if (isOnlineRef.current && !syncingRef.current && retryTimerRef.current === null && itemOwner === ownerRef.current) {
          scheduleAutoSync(retryDelayMs(1));
        }
        return true;
      }
      // Not stored: it must not look kept. Take it back out of the list — and
      // put back what it had replaced (an earlier card edit of the same account),
      // so a failed save never costs the user the edit that WAS kept.
      const replaced = replacedBy(before, next);
      // …and it is not finished after all.
      if (superseded.length > 0) doneRef.current = doneRef.current.filter((done) => !superseded.includes(done));
      const now = queueRef.current;
      const present = new Set(now.map((it) => it.id));
      await commit([...replaced.filter((it) => !present.has(it.id)), ...now.filter((it) => it.id !== id)]);
      return false;
    },
    [commit, scheduleAutoSync],
  );

  const enqueueContact = useCallback(
    async (payload: ContactInput, meta: EnqueueMeta): Promise<EnqueueResult> => {
      const itemOwner = enqueueOwner(meta.owner);
      if (!itemOwner) return { ok: false, reason: "no-owner" };
      await hydration.current?.promise;
      const id = makeQueueId();
      const draft: QueueItemDraft = { kind: "contact", label: meta.label, source: meta.source, payload };
      // Doubt about a lost answer is recorded only where the sync cannot check it (no scan to ask about).
      if (meta.answerLost && repeatIsUnverifiable(draft)) draft.uncertain = true;
      const stored = await keep(draft, itemOwner, id);
      return stored ? { ok: true, id } : { ok: false, reason: "storage-unavailable" };
    },
    [enqueueOwner, keep],
  );

  const enqueueScan = useCallback(
    async (imageData: string | null, meta: EnqueueMeta, progress?: ScanProgress): Promise<EnqueueResult> => {
      const itemOwner = enqueueOwner(meta.owner);
      if (!itemOwner) return { ok: false, reason: "no-owner" };
      await hydration.current?.promise;
      const id = makeQueueId();
      const base: QueueItemDraft = {
        kind: "scan",
        label: meta.label,
        source: meta.source,
        appLanguage: meta.appLanguage,
        eventId: meta.eventId ?? null,
        latitude: meta.latitude ?? null,
        longitude: meta.longitude ?? null,
        gpsAccuracy: meta.gpsAccuracy ?? null,
      };
      if (progress) {
        // The server already holds the photo and its reading; only the contact is missing.
        const stored = await keep({ ...base, scanId: progress.scanId, extracted: progress.extracted ?? {} }, itemOwner, id);
        return stored ? { ok: true, id } : { ok: false, reason: "storage-unavailable" };
      }
      if (!imageData) return { ok: false, reason: "image-invalid" };
      if (!scanFiles.available()) {
        // Web preview: no file storage — the photo stays inline, as before.
        const stored = await keep({ ...base, imageData }, itemOwner, id);
        return stored ? { ok: true, id } : { ok: false, reason: "storage-unavailable" };
      }
      inFlightRef.current.add(id);
      try {
        let image;
        try {
          image = await scanFiles.saveImage(itemOwner, id, imageData);
        } catch (err) {
          return { ok: false, reason: enqueueFailureOf(err) };
        }
        const stored = await keep({ ...base, imageFile: image.file, imageBytes: image.bytes }, itemOwner, id);
        if (!stored) {
          // The entry could not be stored, so the photo written a moment ago is not a pending scan.
          await scanFiles.deleteImage(itemOwner, image.file);
          return { ok: false, reason: "storage-unavailable" };
        }
        return { ok: true, id };
      } finally {
        inFlightRef.current.delete(id);
      }
    },
    [enqueueOwner, keep],
  );

  const enqueueCard = useCallback(
    async (payload: BusinessCardInput, label: string): Promise<EnqueueResult> => {
      // Collapses to a single pending card edit PER OWNER — only the latest of
      // this account matters; another account's queued card edit is kept.
      const itemOwner = enqueueOwner();
      if (!itemOwner) return { ok: false, reason: "no-owner" };
      await hydration.current?.promise;
      const id = makeQueueId();
      const stored = await keep({ kind: "card", label, source: "card", cardPayload: payload }, itemOwner, id);
      return stored ? { ok: true, id } : { ok: false, reason: "storage-unavailable" };
    },
    [enqueueOwner, keep],
  );

  // retry / remove / resolve act only on the current owner's own item (a
  // foreign or quarantined id is a safe no-op).
  const retryItem = useCallback(
    (id: string) => {
      const next = retryOwnedItem(queueRef.current, id, ownerRef.current);
      if (next === queueRef.current) return;
      void commit(next).then(() => runSync(true));
    },
    [commit, runSync],
  );

  const removeItem = useCallback(
    (id: string) => {
      const target = queueRef.current.find((it) => it.id === id);
      // An item whose request is under way stays: removing it here would not
      // stop the request, and the contact would be created all the same.
      if (target?.status === "syncing") return;
      const next = removeOwnedItem(queueRef.current, id, ownerRef.current);
      if (next === queueRef.current || !target) return;
      // The user removed it: its photo goes with it, and is never restored as new work.
      doneRef.current = rememberDone(doneRef.current, id);
      void commit(next).then(() => {
        if (target.imageFile) void scanFiles.deleteImage(target.owner, target.imageFile);
      });
    },
    [commit],
  );

  const resolveConflict = useCallback(
    (id: string, mode: QueueResolution["mode"]) => {
      const next = resolveOwnedConflict(queueRef.current, id, ownerRef.current, mode);
      if (next === queueRef.current) return;
      void commit(next).then(() => runSync(true));
    },
    [commit, runSync],
  );

  const discardDamaged = useCallback(async () => {
    const next = await discardDamagedCopies();
    if (!next) return;
    incidentRef.current = next;
    setIncident(next);
  }, []);

  const discardLegacyItems = useCallback(() => {
    const dropped = queueRef.current.filter((it) => it.owner === null);
    if (dropped.length === 0) return;
    for (const it of dropped) doneRef.current = rememberDone(doneRef.current, it.id);
    void commit(discardQuarantined(queueRef.current)).then(() => {
      for (const it of dropped) if (it.imageFile) void scanFiles.deleteImage(null, it.imageFile);
    });
  }, [commit]);

  const visible = visibleQueue(queue, owner);
  const counts = queueCounts(queue, owner);

  const value: OfflineContextValue = {
    isConnected,
    manualOffline,
    isOnline,
    queue: visible,
    pendingCount: counts.pending,
    failedCount: counts.failed,
    conflictCount: counts.conflicts,
    queuedCount: counts.queued,
    legacyCount: countQuarantined(queue),
    isSyncing,
    lastSyncAt,
    syncNotice,
    storageProblem,
    legacyUnreadable,
    recoveredCount,
    incident,
    discardDamagedCopies: discardDamaged,
    setManualOffline,
    captureOwner,
    enqueueContact,
    enqueueScan,
    enqueueCard,
    syncNow: () => void runSync(true),
    retryItem,
    removeItem,
    resolveConflict,
    discardLegacyItems,
  };

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  return useContext(OfflineContext);
}
