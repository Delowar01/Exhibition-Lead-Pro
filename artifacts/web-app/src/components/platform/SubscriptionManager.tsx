import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePlatformListPlans,
  getPlatformListPlansQueryKey,
  usePlatformGetSubscription,
  usePlatformListSubscriptionEvents,
  usePlatformSetSubscriptionPlan,
  usePlatformStartTrial,
  usePlatformActivateSubscription,
  usePlatformMarkSubscriptionPastDue,
  usePlatformCancelSubscription,
  usePlatformExpireSubscription,
  usePlatformSuspendSubscription,
  usePlatformReactivateSubscription,
  usePlatformSetSubscriptionLimits,
  usePlatformConvertSubscriptionToManual,
  usePlatformSyncSubscription,
  usePlatformListPlanVersions,
  getPlatformListPlanVersionsQueryKey,
  usePlatformPreviewSubscriptionPlanChange,
  usePlatformSubscriptionPlanHistory,
  getPlatformSubscriptionPlanHistoryQueryKey,
  getPlatformListSubscriptionsQueryKey,
  getPlatformGetSubscriptionQueryKey,
  getPlatformListSubscriptionEventsQueryKey,
  getPlatformSubscriptionMetricsQueryKey,
  getListCompaniesQueryKey,
  getGetCompanyQueryKey,
  getListCompanyAuditQueryKey,
  getGetPlatformStatsQueryKey,
  ApiError,
  type PlatformSubscriptionDetail,
  type PlatformPlanChangePreview,
  type PlatformPlanHistoryEntry,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { TableSkeleton, ErrorState, StatusBadge } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { RefreshCw } from "lucide-react";

// Batch 21 — the platform-owner subscription manager, extracted from the
// Subscriptions screen so the Companies list and the tenant detail page reuse
// ONE implementation: canonical detail (status, plan, billing source, access,
// usage and effective limits, provider diagnostics), the server-reported
// `allowedActions`, and a confirmation dialog for every manual lifecycle action.
// Every mutation goes through the existing /platform/subscriptions routes
// (transaction + transition table + audit); nothing here invents billing policy.
//
// Batch 42 (PB-4) — "Change plan" targets a PUBLISHED plan version (the plan's
// current one by default, or an explicit published / retired version), shows the
// server's read-only preview of the change (target limits vs measured usage with
// the tenant's overrides, U6 blockers, feature losses, trial policy) and requires
// the explicit feature-downgrade confirmation (owner decision D3) when the target
// removes features. The dialog never decides eligibility itself: the same
// evaluation runs again inside the change transaction and refuses anything the
// preview missed. The detail dialog also shows the tenant's plan / version history
// projected from the audit trail.

export const STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;
/** The five permanent plan ids — the fallback until the live catalog loads (Batch 40 made the catalog dynamic). */
export const PLANS = ["free", "starter", "professional", "business", "enterprise"] as const;

/**
 * Plan ids from the live catalog. `assignable` = published + active plans (the
 * only ones the API accepts for assignments, company creation and price
 * registration); `all` = every plan (list filters). Falls back to the fixed five
 * while the catalog is loading or unavailable.
 */
export function usePlanOptions(enabled = true): { assignable: string[]; priceable: string[]; all: string[]; nameOf: (id: string) => string } {
  const catalog = usePlatformListPlans({ query: { enabled, queryKey: getPlatformListPlansQueryKey(), staleTime: 60_000 } });
  return useMemo(() => {
    const plans = catalog.data?.plans ?? [];
    if (plans.length === 0) return { assignable: [...PLANS], priceable: [...PLANS], all: [...PLANS], nameOf: (id: string) => id };
    const names = new Map(plans.map((p) => [p.id, p.name] as const));
    return {
      assignable: plans.filter((p) => p.status === "published" && p.isActive).map((p) => p.id),
      // Batch 42: a provider price may be registered for a draft plan too (priced before publication); never for an archived one.
      priceable: plans.filter((p) => p.status !== "archived").map((p) => p.id),
      all: plans.map((p) => p.id),
      nameOf: (id: string) => names.get(id) ?? id,
    };
  }, [catalog.data]);
}
export const STATUS_LABEL: Record<string, string> = { trialing: "Trial", active: "Active", past_due: "Past due", cancelled: "Cancelled", expired: "Expired", suspended: "Suspended" };
/** Canonical status words for tenant rows and the tenant page (mirrors the API vocabulary). */
export const CANONICAL_STATUS_LABEL: Record<string, string> = { trialing: "Trialing", active: "Active", past_due: "Past due", cancelled: "Cancelled", expired: "Expired", suspended: "Suspended" };
export const ACCESS_LABEL: Record<string, string> = { full: "Full access", read_only: "Read-only", blocked: "Blocked" };
export const ACTION_LABEL: Record<string, string> = {
  set_plan: "Change plan",
  start_trial: "Start / extend trial",
  activate: "Activate",
  mark_past_due: "Mark past due",
  cancel: "Cancel (read-only)",
  expire: "Expire (blocked)",
  suspend: "Suspend (blocked)",
  reactivate: "Lift suspension",
  set_limits: "Set limit overrides",
  convert_to_manual: "Convert to manual",
  sync_provider: "Sync from provider",
};
export const LIMIT_RESOURCES = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;
export const HISTORY_KIND_LABEL: Record<string, string> = {
  created: "Created",
  direct_change: "Plan changed",
  version_change: "Version changed",
  repair: "Reference repaired",
  migration: "Migrated",
  provider_sync: "Provider sync",
  backfill_pin: "Pinned (backfill)",
  other: "Change",
};
export function planRef(plan: string | null | undefined, version: number | null | undefined): string {
  if (!plan) return "—";
  return version == null ? `${plan} (legacy)` : `${plan} v${version}`;
}

export function statusTone(status: string | null | undefined): "success" | "warning" | "destructive" | "neutral" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "cancelled") return "warning";
  if (status === "expired" || status === "suspended") return "destructive";
  return "neutral";
}
export function accessTone(mode: string | null | undefined): "success" | "warning" | "destructive" | "neutral" {
  if (mode === "full") return "success";
  if (mode === "read_only") return "warning";
  if (mode === "blocked") return "destructive";
  return "neutral";
}
export function fmt(d: string | null | undefined): string {
  return d ? format(new Date(d), "MMM d, yyyy") : "—";
}
export function fmtDateTime(d: string | null | undefined): string {
  return d ? format(new Date(d), "MMM d, yyyy HH:mm") : "—";
}
export function errMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.data as { error?: string; code?: string } | null;
    return d?.error ? `${d.error}${d.code ? ` (${d.code})` : ""}` : err.message;
  }
  return err instanceof Error ? err.message : "Request failed";
}

type Verb = "set_plan" | "start_trial" | "activate" | "mark_past_due" | "cancel" | "expire" | "suspend" | "reactivate" | "set_limits" | "convert_to_manual" | "sync_provider";

/** Invalidates every platform query that shows this company's canonical state. */
export function invalidateCompanyQueries(queryClient: ReturnType<typeof useQueryClient>, companyId?: number | null) {
  void queryClient.invalidateQueries({ queryKey: getPlatformListSubscriptionsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getPlatformSubscriptionMetricsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
  void queryClient.invalidateQueries({ queryKey: getGetPlatformStatsQueryKey() });
  if (companyId != null) {
    void queryClient.invalidateQueries({ queryKey: getPlatformGetSubscriptionQueryKey(companyId) });
    void queryClient.invalidateQueries({ queryKey: getPlatformListSubscriptionEventsQueryKey(companyId) });
    void queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey(companyId) });
    void queryClient.invalidateQueries({ queryKey: getListCompanyAuditQueryKey(companyId) });
    void queryClient.invalidateQueries({ queryKey: getPlatformSubscriptionPlanHistoryQueryKey(companyId) });
  }
}

export interface SubscriptionManagerProps {
  /** Company whose canonical subscription is managed; null keeps the dialog closed. */
  companyId: number | null;
  onClose: () => void;
  /** Called after any successful lifecycle action. */
  onChanged?: (companyId: number) => void;
}

export function SubscriptionManager({ companyId, onClose, onChanged }: SubscriptionManagerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ verb: Verb; companyId: number } | null>(null);
  const [planChoice, setPlanChoice] = useState<string>("starter");
  const [trialDays, setTrialDays] = useState<string>("14");
  const [reason, setReason] = useState("");
  const [limitInputs, setLimitInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Batch 42 — change-plan dialog state: "" = the plan's current published version.
  const [planVersionChoice, setPlanVersionChoice] = useState<string>("");
  const [confirmFeatureDowngrade, setConfirmFeatureDowngrade] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [preview, setPreview] = useState<PlatformPlanChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const open = companyId != null;
  const planOptions = usePlanOptions(open);
  const detail = usePlatformGetSubscription(companyId ?? 0, { query: { enabled: open, queryKey: getPlatformGetSubscriptionQueryKey(companyId ?? 0) } });
  const events = usePlatformListSubscriptionEvents(companyId ?? 0, { query: { enabled: open, queryKey: getPlatformListSubscriptionEventsQueryKey(companyId ?? 0) } });
  const history = usePlatformSubscriptionPlanHistory(companyId ?? 0, { query: { enabled: open, queryKey: getPlatformSubscriptionPlanHistoryQueryKey(companyId ?? 0) } });
  const changingPlan = pending?.verb === "set_plan";
  const targetVersions = usePlatformListPlanVersions(planChoice, { query: { enabled: changingPlan && !!planChoice, queryKey: getPlatformListPlanVersionsQueryKey(planChoice) } });
  const previewMutation = usePlatformPreviewSubscriptionPlanChange();
  const previewMutate = previewMutation.mutateAsync;
  // Read-only preview of the change: re-evaluated whenever the target changes; the
  // server repeats the same evaluation inside the change transaction.
  useEffect(() => {
    if (!changingPlan || !pending || !planChoice) return;
    let cancelled = false;
    setPreviewBusy(true);
    setPreviewError(null);
    const versionId = planVersionChoice ? Number(planVersionChoice) : undefined;
    previewMutate({ companyId: pending.companyId, data: { plan: planChoice, ...(versionId ? { planVersionId: versionId } : {}) } })
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(errMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [changingPlan, pending, planChoice, planVersionChoice, previewMutate]);

  const m = {
    setPlan: usePlatformSetSubscriptionPlan(),
    startTrial: usePlatformStartTrial(),
    activate: usePlatformActivateSubscription(),
    pastDue: usePlatformMarkSubscriptionPastDue(),
    cancel: usePlatformCancelSubscription(),
    expire: usePlatformExpireSubscription(),
    suspend: usePlatformSuspendSubscription(),
    reactivate: usePlatformReactivateSubscription(),
    limits: usePlatformSetSubscriptionLimits(),
    convert: usePlatformConvertSubscriptionToManual(),
    sync: usePlatformSyncSubscription(),
  };

  const openAction = (verb: Verb, d: PlatformSubscriptionDetail) => {
    if (verb === "set_plan") {
      setPlanChoice(d.plan);
      setPlanVersionChoice("");
      setConfirmFeatureDowngrade(false);
      setChangeReason("");
      setPreview(null);
      setPreviewError(null);
    }
    if (verb === "start_trial") setTrialDays("14");
    if (verb === "suspend") setReason("");
    if (verb === "set_limits") {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.limitOverrides ?? {})) next[k] = v == null ? "" : String(v);
      setLimitInputs(next);
    }
    setPending({ verb, companyId: d.companyId });
  };

  const runAction = async () => {
    if (!pending) return;
    const { verb, companyId: cid } = pending;
    setBusy(true);
    try {
      switch (verb) {
        case "set_plan": {
          const versionId = planVersionChoice ? Number(planVersionChoice) : undefined;
          await m.setPlan.mutateAsync({
            companyId: cid,
            data: {
              plan: planChoice,
              ...(versionId ? { planVersionId: versionId } : {}),
              ...(confirmFeatureDowngrade ? { confirmFeatureDowngrade: true } : {}),
              ...(changeReason.trim() ? { reason: changeReason.trim() } : {}),
            },
          });
          break;
        }
        case "start_trial":
          await m.startTrial.mutateAsync({ companyId: cid, data: { trialDays: Math.max(1, Math.min(365, Number(trialDays) || 14)) } });
          break;
        case "activate":
          await m.activate.mutateAsync({ companyId: cid });
          break;
        case "mark_past_due":
          await m.pastDue.mutateAsync({ companyId: cid });
          break;
        case "cancel":
          await m.cancel.mutateAsync({ companyId: cid });
          break;
        case "expire":
          await m.expire.mutateAsync({ companyId: cid });
          break;
        case "suspend":
          await m.suspend.mutateAsync({ companyId: cid, data: { reason: reason.trim() || undefined } });
          break;
        case "reactivate":
          await m.reactivate.mutateAsync({ companyId: cid });
          break;
        case "set_limits": {
          const limits: Record<string, number | null> = {};
          for (const k of LIMIT_RESOURCES) {
            const raw = (limitInputs[k] ?? "").trim();
            limits[k] = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
          }
          await m.limits.mutateAsync({ companyId: cid, data: { limits } });
          break;
        }
        case "convert_to_manual":
          await m.convert.mutateAsync({ companyId: cid });
          break;
        case "sync_provider":
          await m.sync.mutateAsync({ companyId: cid });
          break;
      }
      toast({ title: `${ACTION_LABEL[verb]} applied` });
      invalidateCompanyQueries(queryClient, cid);
      onChanged?.(cid);
      setPending(null);
    } catch (err) {
      toast({ title: `${ACTION_LABEL[verb]} failed`, description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const d = detail.data;
  const assignableVersions = (targetVersions.data?.versions ?? []).filter((x) => x.state !== "draft");
  const confirmBlocked =
    changingPlan && (previewBusy || (preview != null && (!preview.eligible || (preview.requiresFeatureConfirmation && !confirmFeatureDowngrade))));
  const historyEntries: PlatformPlanHistoryEntry[] = history.data ? [...history.data.entries].reverse() : [];

  return (
    <>
      {/* ── Detail / manage dialog ───────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="sub-detail">
          {/* Title + description are always rendered (accessible name while the detail loads). */}
          <DialogHeader>
            <DialogTitle>{d ? (d.companyName ?? `Company ${d.companyId}`) : "Subscription"}</DialogTitle>
            <DialogDescription>
              {d ? (
                <>
                  <span className="capitalize">{d.plan}</span> · {STATUS_LABEL[d.status] ?? d.status} · {d.billingSource === "stripe" ? "Stripe-managed" : "manual"} · access {d.accessMode.replace("_", "-")}
                </>
              ) : detail.isError ? (
                "The canonical subscription could not be loaded."
              ) : (
                "Loading the canonical subscription…"
              )}
            </DialogDescription>
          </DialogHeader>
          {d ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><span className="text-muted-foreground">Trial ends</span><div data-testid="detail-trial">{fmt(d.trialExpiresAt)}</div></div>
                <div><span className="text-muted-foreground">Current period ends</span><div>{fmt(d.currentPeriodEndsAt)}{d.cancelAtPeriodEnd ? " (cancels)" : ""}</div></div>
                <div><span className="text-muted-foreground">Status changed</span><div>{fmt(d.statusChangedAt)}</div></div>
                <div><span className="text-muted-foreground">Provider</span><div>{d.providerLinked ? `linked (${d.providerCustomerRef ?? "…"})` : "not linked"}{d.providerStatus ? ` · ${d.providerStatus}` : ""}</div></div>
                {d.suspendedReason && <div className="sm:col-span-2"><span className="text-muted-foreground">Suspension reason</span><div>{d.suspendedReason}</div></div>}
                {d.providerConflict && (
                  <div className="sm:col-span-2 text-destructive" data-testid="detail-provider-conflict">
                    <span className="font-medium">Provider conflict</span>
                    <div>A second live provider subscription for this company was refused ({d.providerConflict.eventType}, ref {d.providerConflict.eventRef ?? "…"}, {fmt(d.providerConflict.receivedAt)}). Resolve it in the provider dashboard; the canonical subscription was not changed.</div>
                  </div>
                )}
                {d.providerPriceUnmapped && (
                  <div className="sm:col-span-2 text-destructive" data-testid="detail-price-unmapped">
                    <span className="font-medium">Unregistered provider price</span>
                    <div>A provider delivery could not be applied because its price is not registered ({d.providerPriceUnmapped.eventType}, ref {d.providerPriceUnmapped.eventRef ?? "…"}, {fmt(d.providerPriceUnmapped.receivedAt)}, attempts {d.providerPriceUnmapped.attempts ?? 1}). Register the price, then re-sync.</div>
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Usage and effective limits</div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Resource</TableHead><TableHead className="text-right">Used</TableHead><TableHead className="text-right">Limit</TableHead><TableHead>Source</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.usage.resources.map((r) => (
                        <TableRow key={r.resource}>
                          <TableCell className="capitalize">{r.resource}</TableCell>
                          <TableCell className="text-right">{r.measurable ? r.used : "n/a"}</TableCell>
                          <TableCell className="text-right">{r.limit == null ? "Unlimited" : r.limit}</TableCell>
                          <TableCell className="text-muted-foreground">{r.source}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Actions</div>
                <div className="flex flex-wrap gap-2" data-testid="detail-actions">
                  {d.allowedActions.map((a) => (
                    <Button key={a} size="sm" variant={a === "expire" || a === "suspend" || a === "cancel" ? "destructive" : "outline"} onClick={() => openAction(a as Verb, d)} data-testid={`action-${a}`}>
                      {a === "sync_provider" && <RefreshCw className="mr-1 h-3 w-3" />}
                      {ACTION_LABEL[a] ?? a}
                    </Button>
                  ))}
                </div>
              </div>
              <div data-testid="plan-history">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">Plan and version history</div>
                  {history.data && (
                    <Button variant="ghost" size="sm" onClick={() => setHistoryOpen((o) => !o)} data-testid="plan-history-toggle">
                      {historyOpen ? "Hide" : `Show ${history.data.total} change${history.data.total === 1 ? "" : "s"}`}
                    </Button>
                  )}
                </div>
                {history.isError ? (
                  <p className="text-xs text-destructive">{errMessage(history.error)}</p>
                ) : history.data ? (
                  <>
                    <p className="text-xs text-muted-foreground" data-testid="plan-history-summary">
                      Original {planRef(history.data.original.plan, history.data.original.version)}
                      {history.data.original.at ? ` (${fmtDateTime(history.data.original.at)})` : ""} · now {planRef(history.data.current.plan, history.data.current.version)}
                      {history.data.current.versionState ? ` (${history.data.current.versionState})` : ""} · {history.data.current.billingSource === "stripe" ? "provider-managed" : "manual billing"}
                      {history.data.truncated ? " · history truncated" : ""}
                    </p>
                    {historyOpen && (
                      <div className="mt-2 overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow><TableHead>When</TableHead><TableHead>Change</TableHead><TableHead>From → to</TableHead><TableHead>By</TableHead><TableHead>Details</TableHead></TableRow>
                          </TableHeader>
                          <TableBody>
                            {historyEntries.length === 0 ? (
                              <TableRow><TableCell colSpan={5} className="text-muted-foreground">No plan change recorded.</TableCell></TableRow>
                            ) : (
                              historyEntries.map((e) => (
                                <TableRow key={e.auditId} data-testid={`plan-history-row-${e.auditId}`} data-kind={e.kind}>
                                  <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(e.at)}</TableCell>
                                  <TableCell className="text-xs">{HISTORY_KIND_LABEL[e.kind] ?? e.kind}{e.source === "migration" ? " (batch)" : e.source === "provider_price" ? " (provider price)" : ""}</TableCell>
                                  <TableCell className="text-xs">{planRef(e.fromPlan, e.fromVersion)} → {planRef(e.toPlan, e.toVersion)}</TableCell>
                                  <TableCell className="text-xs">{e.actor.name ?? (e.actor.userId != null ? `user ${e.actor.userId}` : "system")}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {[
                                      e.reason ? `reason: ${e.reason}` : null,
                                      e.tightenedLimits.length ? `tightens ${e.tightenedLimits.join(", ")}` : null,
                                      e.loosenedLimits.length ? `loosens ${e.loosenedLimits.join(", ")}` : null,
                                      e.lostFeatures.length ? `features removed: ${e.lostFeatures.join(", ")}` : null,
                                      e.gainedFeatures.length ? `features added: ${e.gainedFeatures.join(", ")}` : null,
                                      e.featureEnforcementBefore && e.featureEnforcementAfter && e.featureEnforcementBefore !== e.featureEnforcementAfter ? `enforcement ${e.featureEnforcementBefore} → ${e.featureEnforcementAfter}` : null,
                                      e.repairedInvalidReference ? "invalid reference repaired" : null,
                                      e.migrationId ? `migration ${e.migrationId.slice(0, 8)}` : null,
                                      e.billingSource ? e.billingSource : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ") || "—"}
                                  </TableCell>
                                </TableRow>
                              ))
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading history…</p>
                )}
              </div>
              {(events.data?.events.length ?? 0) > 0 && (
                <div>
                  <div className="text-sm font-medium mb-2">Recent provider events</div>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    {events.data?.events.slice(0, 8).map((e) => (
                      <li key={e.id}>{fmt(e.receivedAt)} · {e.eventType} · {e.outcome ?? e.status}{e.failureCode ? ` · ${e.failureCode}` : ""}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : detail.isError ? (
            <ErrorState
              title="Subscription unavailable"
              description={errMessage(detail.error)}
              action={<Button variant="outline" size="sm" onClick={() => void detail.refetch()} data-testid="sub-detail-retry">Retry</Button>}
            />
          ) : (
            <div className="p-6"><TableSkeleton rows={4} /></div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirmation dialog for every lifecycle action ───────────────── */}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <AlertDialogContent data-testid="lifecycle-dialog" className="max-h-[90vh] overflow-y-auto">
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{ACTION_LABEL[pending.verb]}</AlertDialogTitle>
                <AlertDialogDescription>
                  {pending.verb === "expire" && "The company will be blocked from signing in. No data is deleted."}
                  {pending.verb === "suspend" && "The company will be blocked from signing in until the suspension is lifted. No data is deleted."}
                  {pending.verb === "cancel" && "The company keeps read-only access. No data is deleted."}
                  {pending.verb === "mark_past_due" && "The company keeps read-only access until it is activated again."}
                  {pending.verb === "activate" && "The company regains full access on its manual plan."}
                  {pending.verb === "reactivate" && "The suspension is lifted and the previous state is restored."}
                  {pending.verb === "set_plan" && "Changes the manual plan immediately (no period-end scheduling). The tenant is pinned to the chosen published version; effective limits follow that version unless overridden. The server re-evaluates usage and features inside the change."}
                  {pending.verb === "start_trial" && "Starts or extends a manual trial; access is full until it ends."}
                  {pending.verb === "set_limits" && "Overrides replace the plan defaults for this company. Leave a field empty to use the plan default."}
                  {pending.verb === "convert_to_manual" && "Allowed only when no live provider subscription remains."}
                  {pending.verb === "sync_provider" && "Re-reads the provider subscription and applies its authoritative state."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {pending.verb === "set_plan" && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Plan</Label>
                    <Select value={planChoice} onValueChange={(v) => { setPlanChoice(v); setPlanVersionChoice(""); setConfirmFeatureDowngrade(false); }}>
                      <SelectTrigger data-testid="plan-select"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {planOptions.assignable.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                        {pending && !planOptions.assignable.includes(planChoice) && <SelectItem value={planChoice} className="capitalize">{planChoice} (current, not assignable)</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Version</Label>
                    <Select value={planVersionChoice || "__current"} onValueChange={(v) => { setPlanVersionChoice(v === "__current" ? "" : v); setConfirmFeatureDowngrade(false); }}>
                      <SelectTrigger data-testid="plan-version-select"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__current">Current published version (default)</SelectItem>
                        {assignableVersions.map((x) => (
                          <SelectItem key={x.id} value={String(x.id)}>
                            v{x.version} · {x.state === "retired" ? "retired (kept for its subscribers)" : x.isCurrent ? "published · current" : "published"}
                            {d && d.planVersionId === x.id ? " · tenant's current" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Only published versions can be assigned; drafts never. A retired version is a deliberate choice.</p>
                  </div>
                  <div className="rounded-md border p-3 text-sm" data-testid="plan-change-preview" data-eligible={preview ? (preview.eligible ? "true" : "false") : undefined}>
                    {previewBusy ? (
                      <p className="text-muted-foreground">Evaluating the change…</p>
                    ) : previewError ? (
                      <p className="text-destructive" data-testid="preview-error">{previewError}</p>
                    ) : preview ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium" data-testid="preview-target">
                            {planRef(preview.current.plan, preview.current.version)} → {planRef(preview.target.plan, preview.target.version)}
                          </span>
                          <Badge variant="outline">{preview.target.state}</Badge>
                          <Badge variant="secondary" data-testid="preview-kind">{preview.changeKind === "none" ? "no change" : preview.changeKind.replace("_", " ")}</Badge>
                          {preview.tightenedLimits.length > 0 && <StatusBadge tone="warning">tightens {preview.tightenedLimits.join(", ")}</StatusBadge>}
                          {preview.loosenedLimits.length > 0 && <StatusBadge tone="success">loosens {preview.loosenedLimits.join(", ")}</StatusBadge>}
                        </div>
                        {!preview.transition.ok && (
                          <p className="text-destructive" data-testid="preview-transition">Not allowed for this subscription ({preview.transition.code ?? "transition"}).</p>
                        )}
                        {preview.blocking.length > 0 && (
                          <div className="text-destructive" data-testid="preview-blocking">
                            <p className="font-medium">Blocked: current usage exceeds the target limits.</p>
                            <ul className="list-disc pl-5">
                              {preview.blocking.map((b) => <li key={b.resource}>{b.resource}: {b.used} used, limit {b.limit}</li>)}
                            </ul>
                            <p className="text-xs">Reduce usage or set a limit override first. No data is ever deleted by a plan change.</p>
                          </div>
                        )}
                        {preview.unmeasurable.length > 0 && (
                          <p className="text-xs text-muted-foreground" data-testid="preview-unmeasurable">Not verified (unmeasurable here): {preview.unmeasurable.join(", ")}.</p>
                        )}
                        {preview.features.lost.length > 0 && (
                          <div data-testid="preview-lost-features">
                            <p className="font-medium text-amber-700 dark:text-amber-400">Features removed: {preview.features.lost.join(", ")}</p>
                            {preview.requiresFeatureConfirmation && (
                              <label className="mt-1 flex items-start gap-2 text-sm">
                                <Checkbox checked={confirmFeatureDowngrade} onCheckedChange={(v) => setConfirmFeatureDowngrade(v === true)} data-testid="plan-change-confirm-features" />
                                <span>I confirm this feature-only downgrade; the tenant loses access to the features listed above immediately.</span>
                              </label>
                            )}
                          </div>
                        )}
                        {preview.features.gained.length > 0 && <p className="text-xs text-muted-foreground">Features added: {preview.features.gained.join(", ")}.</p>}
                        {(preview.trialPolicy.current.endOutcome !== preview.trialPolicy.target.endOutcome || preview.trialPolicy.current.readOnlyGraceDays !== preview.trialPolicy.target.readOnlyGraceDays) && (
                          <p className="text-xs text-muted-foreground">Trial end policy: {preview.trialPolicy.current.endOutcome}/{preview.trialPolicy.current.readOnlyGraceDays}d → {preview.trialPolicy.target.endOutcome}/{preview.trialPolicy.target.readOnlyGraceDays}d.</p>
                        )}
                        {preview.changeKind === "none" && <p className="text-muted-foreground">The tenant is already on this target; nothing would change.</p>}
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground">Limit comparison ({preview.limits.length})</summary>
                          <Table>
                            <TableHeader><TableRow><TableHead>Resource</TableHead><TableHead className="text-right">Used</TableHead><TableHead className="text-right">Now</TableHead><TableHead className="text-right">Target</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
                            <TableBody>
                              {preview.limits.map((l) => (
                                <TableRow key={l.resource} data-testid={`preview-limit-${l.resource}`} data-exceeds={l.exceeds ? "true" : "false"}>
                                  <TableCell className="capitalize">{l.resource}</TableCell>
                                  <TableCell className="text-right">{l.measurable ? l.used : "n/a"}</TableCell>
                                  <TableCell className="text-right">{l.currentLimit == null ? "Unlimited" : l.currentLimit}</TableCell>
                                  <TableCell className={`text-right ${l.exceeds ? "text-destructive font-medium" : ""}`}>{l.targetLimit == null ? "Unlimited" : l.targetLimit}</TableCell>
                                  <TableCell className="text-muted-foreground">{l.targetSource}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </details>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">Pick a plan to evaluate the change.</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="plan-change-reason">Reason (optional, recorded in the audit trail)</Label>
                    <Input id="plan-change-reason" maxLength={200} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} data-testid="plan-change-reason" />
                  </div>
                </div>
              )}
              {pending.verb === "start_trial" && (
                <div className="space-y-2">
                  <Label htmlFor="trial-days">Trial length (days)</Label>
                  <Input id="trial-days" type="number" min={1} max={365} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} data-testid="trial-days" />
                </div>
              )}
              {pending.verb === "suspend" && (
                <div className="space-y-2">
                  <Label htmlFor="suspend-reason">Reason (optional, shown to the platform team only)</Label>
                  <Input id="suspend-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="suspend-reason" />
                </div>
              )}
              {pending.verb === "set_limits" && (
                <div className="grid grid-cols-2 gap-3">
                  {LIMIT_RESOURCES.map((k) => (
                    <div key={k} className="space-y-1">
                      <Label htmlFor={`limit-${k}`} className="capitalize">{k}</Label>
                      <Input id={`limit-${k}`} type="number" min={0} placeholder="plan default" value={limitInputs[k] ?? ""} onChange={(e) => setLimitInputs({ ...limitInputs, [k]: e.target.value })} data-testid={`limit-${k}`} />
                    </div>
                  ))}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); void runAction(); }} disabled={busy || confirmBlocked} data-testid="lifecycle-confirm">
                  {busy ? "Applying…" : "Confirm"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
