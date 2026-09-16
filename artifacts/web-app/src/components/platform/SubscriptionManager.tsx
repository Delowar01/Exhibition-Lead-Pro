import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
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
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { TableSkeleton, ErrorState } from "@/components/ds";
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

export const STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;
export const PLANS = ["free", "starter", "professional", "business", "enterprise"] as const;
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

  const open = companyId != null;
  const detail = usePlatformGetSubscription(companyId ?? 0, { query: { enabled: open, queryKey: getPlatformGetSubscriptionQueryKey(companyId ?? 0) } });
  const events = usePlatformListSubscriptionEvents(companyId ?? 0, { query: { enabled: open, queryKey: getPlatformListSubscriptionEventsQueryKey(companyId ?? 0) } });

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
    if (verb === "set_plan") setPlanChoice(d.plan);
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
        case "set_plan":
          await m.setPlan.mutateAsync({ companyId: cid, data: { plan: planChoice as (typeof PLANS)[number] } });
          break;
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
        <AlertDialogContent data-testid="lifecycle-dialog">
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
                  {pending.verb === "set_plan" && "Changes the manual plan. Effective limits follow the plan defaults unless overridden."}
                  {pending.verb === "start_trial" && "Starts or extends a manual trial; access is full until it ends."}
                  {pending.verb === "set_limits" && "Overrides replace the plan defaults for this company. Leave a field empty to use the plan default."}
                  {pending.verb === "convert_to_manual" && "Allowed only when no live provider subscription remains."}
                  {pending.verb === "sync_provider" && "Re-reads the provider subscription and applies its authoritative state."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {pending.verb === "set_plan" && (
                <div className="space-y-2">
                  <Label>Plan</Label>
                  <Select value={planChoice} onValueChange={setPlanChoice}>
                    <SelectTrigger data-testid="plan-select"><SelectValue /></SelectTrigger>
                    <SelectContent>{PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
                  </Select>
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
                <AlertDialogAction onClick={(e) => { e.preventDefault(); void runAction(); }} disabled={busy} data-testid="lifecycle-confirm">
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
