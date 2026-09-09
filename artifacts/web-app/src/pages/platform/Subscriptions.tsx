import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePlatformListSubscriptions,
  usePlatformSubscriptionMetrics,
  usePlatformGetSubscription,
  usePlatformListSubscriptionEvents,
  usePlatformBillingStatus,
  usePlatformListPrices,
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
  usePlatformRegisterPrice,
  usePlatformUpdatePrice,
  getPlatformListSubscriptionsQueryKey,
  getPlatformGetSubscriptionQueryKey,
  getPlatformListSubscriptionEventsQueryKey,
  getPlatformSubscriptionMetricsQueryKey,
  getPlatformListPricesQueryKey,
  ApiError,
  type PlatformSubscriptionDetail,
  type PlatformSubscriptionListItem,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, MetricCard, StatusBadge, TableSkeleton, EmptyState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { CreditCard, Search, Building2, RefreshCw } from "lucide-react";

// Batch 20 — truthful Platform Subscriptions screen. Everything on this page is
// real API data: canonical subscription rows with filters + pagination, counts by
// canonical state / plan / billing source, revenue only when it can be computed
// from verified provider prices (otherwise "Unavailable" + reason), and manual
// lifecycle actions with confirmation dialogs. No fake rows, no random numbers,
// no growth percentages, no non-functional buttons.

const STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;
const PLANS = ["free", "starter", "professional", "business", "enterprise"] as const;
const STATUS_LABEL: Record<string, string> = { trialing: "Trial", active: "Active", past_due: "Past due", cancelled: "Cancelled", expired: "Expired", suspended: "Suspended" };
const ACTION_LABEL: Record<string, string> = {
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
const REVENUE_REASON: Record<string, string> = {
  NO_VERIFIED_PRICES: "No provider prices have been registered yet.",
  NO_ACTIVE_PROVIDER_SUBSCRIPTIONS: "No active online subscriptions.",
  UNPRICED_SUBSCRIPTIONS: "Active online subscriptions are not bound to a registered price.",
  MIXED_CURRENCIES: "Active subscriptions use more than one currency.",
  PARTIAL_UNPRICED: "Some active subscriptions are not bound to a registered price.",
};

function tone(status: string): "success" | "warning" | "destructive" | "neutral" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "cancelled") return "warning";
  return "destructive";
}
function fmt(d: string | null | undefined): string {
  return d ? format(new Date(d), "MMM d, yyyy") : "—";
}
function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
function errMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.data as { error?: string; code?: string } | null;
    return d?.error ? `${d.error}${d.code ? ` (${d.code})` : ""}` : err.message;
  }
  return err instanceof Error ? err.message : "Request failed";
}

type Verb = "set_plan" | "start_trial" | "activate" | "mark_past_due" | "cancel" | "expire" | "suspend" | "reactivate" | "set_limits" | "convert_to_manual" | "sync_provider";

export default function PlatformSubscriptions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState("all");
  const [plan, setPlan] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState<{ verb: Verb; companyId: number } | null>(null);
  const [planChoice, setPlanChoice] = useState<string>("starter");
  const [trialDays, setTrialDays] = useState<string>("14");
  const [reason, setReason] = useState("");
  const [limitInputs, setLimitInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [priceForm, setPriceForm] = useState({ planId: "starter", providerPriceId: "" });
  const limit = 20;

  const params = useMemo(
    () => ({
      status: status !== "all" ? (status as (typeof STATUSES)[number]) : undefined,
      plan: plan !== "all" ? plan : undefined,
      billingSource: source !== "all" ? (source as "manual" | "stripe") : undefined,
      search: search.trim() || undefined,
      page,
      limit,
    }),
    [status, plan, source, search, page],
  );
  const list = usePlatformListSubscriptions(params, { query: { queryKey: getPlatformListSubscriptionsQueryKey(params) } });
  const metrics = usePlatformSubscriptionMetrics({ query: { queryKey: getPlatformSubscriptionMetricsQueryKey() } });
  const providerStatus = usePlatformBillingStatus();
  const prices = usePlatformListPrices({ query: { queryKey: getPlatformListPricesQueryKey() } });
  const detail = usePlatformGetSubscription(selected ?? 0, { query: { enabled: selected != null, queryKey: getPlatformGetSubscriptionQueryKey(selected ?? 0) } });
  const events = usePlatformListSubscriptionEvents(selected ?? 0, { query: { enabled: selected != null, queryKey: getPlatformListSubscriptionEventsQueryKey(selected ?? 0) } });

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
    registerPrice: usePlatformRegisterPrice(),
    updatePrice: usePlatformUpdatePrice(),
  };

  const refreshAll = (companyId?: number) => {
    void queryClient.invalidateQueries({ queryKey: getPlatformListSubscriptionsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getPlatformSubscriptionMetricsQueryKey() });
    if (companyId != null) void queryClient.invalidateQueries({ queryKey: getPlatformGetSubscriptionQueryKey(companyId) });
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
    const { verb, companyId } = pending;
    setBusy(true);
    try {
      switch (verb) {
        case "set_plan":
          await m.setPlan.mutateAsync({ companyId, data: { plan: planChoice as (typeof PLANS)[number] } });
          break;
        case "start_trial":
          await m.startTrial.mutateAsync({ companyId, data: { trialDays: Math.max(1, Math.min(365, Number(trialDays) || 14)) } });
          break;
        case "activate":
          await m.activate.mutateAsync({ companyId });
          break;
        case "mark_past_due":
          await m.pastDue.mutateAsync({ companyId });
          break;
        case "cancel":
          await m.cancel.mutateAsync({ companyId });
          break;
        case "expire":
          await m.expire.mutateAsync({ companyId });
          break;
        case "suspend":
          await m.suspend.mutateAsync({ companyId, data: { reason: reason.trim() || undefined } });
          break;
        case "reactivate":
          await m.reactivate.mutateAsync({ companyId });
          break;
        case "set_limits": {
          const limits: Record<string, number | null> = {};
          for (const k of ["contacts", "events", "admins", "employees", "scans", "storageMb"]) {
            const raw = (limitInputs[k] ?? "").trim();
            limits[k] = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
          }
          await m.limits.mutateAsync({ companyId, data: { limits } });
          break;
        }
        case "convert_to_manual":
          await m.convert.mutateAsync({ companyId });
          break;
        case "sync_provider":
          await m.sync.mutateAsync({ companyId });
          break;
      }
      toast({ title: `${ACTION_LABEL[verb]} applied` });
      refreshAll(companyId);
      setPending(null);
    } catch (err) {
      toast({ title: `${ACTION_LABEL[verb]} failed`, description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const registerPrice = async () => {
    setBusy(true);
    try {
      await m.registerPrice.mutateAsync({ data: { planId: priceForm.planId as (typeof PLANS)[number], providerPriceId: priceForm.providerPriceId.trim() } });
      toast({ title: "Price registered" });
      setPriceForm({ ...priceForm, providerPriceId: "" });
      void queryClient.invalidateQueries({ queryKey: getPlatformListPricesQueryKey() });
      refreshAll();
    } catch (err) {
      toast({ title: "Price registration failed", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const togglePrice = async (id: number, active: boolean) => {
    try {
      await m.updatePrice.mutateAsync({ id, data: { active } });
      void queryClient.invalidateQueries({ queryKey: getPlatformListPricesQueryKey() });
      refreshAll();
    } catch (err) {
      toast({ title: "Price update failed", description: errMessage(err), variant: "destructive" });
    }
  };

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const revenue = metrics.data?.revenue;
  const byStatus = new Map((metrics.data?.byStatus ?? []).map((s) => [s.status, s.count]));
  const d = detail.data;

  return (
    <div className="space-y-6" data-testid="platform-subscriptions">
      <PageHeader title="Subscriptions" description="Canonical subscription state for every company — manual lifecycle controls and provider billing." />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div data-testid="mrr-card">
          <MetricCard
            label="Monthly recurring revenue"
            value={revenue?.available && revenue.currency && revenue.monthlyRecurringMinor != null ? money(revenue.monthlyRecurringMinor, revenue.currency) : <span className="text-xl font-semibold text-muted-foreground">Unavailable</span>}
            icon={CreditCard}
            footer={revenue ? (revenue.available ? `${revenue.countedSubscriptions} verified online subscription(s)${revenue.unpricedSubscriptions ? `, ${revenue.unpricedSubscriptions} unpriced` : ""}` : REVENUE_REASON[revenue.reason ?? ""] ?? "Not configured") : "Loading…"}
          />
        </div>
        <MetricCard label="Full access" value={String((byStatus.get("active") ?? 0) + (byStatus.get("trialing") ?? 0))} icon={Building2} footer={`${byStatus.get("active") ?? 0} active · ${byStatus.get("trialing") ?? 0} in trial`} />
        <MetricCard label="Read-only" value={String((byStatus.get("past_due") ?? 0) + (byStatus.get("cancelled") ?? 0))} icon={Building2} footer={`${byStatus.get("past_due") ?? 0} past due · ${byStatus.get("cancelled") ?? 0} cancelled`} />
        <MetricCard label="Blocked" value={String((byStatus.get("expired") ?? 0) + (byStatus.get("suspended") ?? 0))} icon={Building2} footer={`${byStatus.get("expired") ?? 0} expired · ${byStatus.get("suspended") ?? 0} suspended · ${metrics.data?.trialsExpiringWithin7Days ?? 0} trials end within 7 days`} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
            <CardTitle>Subscription list</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full md:w-64">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search company…" className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} data-testid="sub-search" />
              </div>
              <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]" data-testid="sub-status-filter"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={plan} onValueChange={(v) => { setPlan(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]"><SelectValue placeholder="Plan" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={source} onValueChange={(v) => { setSource(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]"><SelectValue placeholder="Billing" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All billing</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="stripe">Stripe</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6"><TableSkeleton rows={5} /></div>
          ) : (list.data?.subscriptions.length ?? 0) === 0 ? (
            <div className="p-6"><EmptyState icon={Building2} title="No subscriptions match" description="Adjust the filters to see other companies." /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Billing</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Trial / period end</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data?.subscriptions.map((s: PlatformSubscriptionListItem) => (
                    <TableRow key={s.id} data-testid={`sub-row-${s.companyId}`}>
                      <TableCell className="font-medium">{s.companyName}</TableCell>
                      <TableCell className="capitalize">{s.plan}</TableCell>
                      <TableCell><StatusBadge tone={tone(s.status)} showDot>{STATUS_LABEL[s.status] ?? s.status}</StatusBadge></TableCell>
                      <TableCell className="capitalize">{s.billingSource}{s.providerLinked ? " · linked" : ""}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.accessMode.replace("_", "-")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmt(s.currentPeriodEndsAt ?? s.trialExpiresAt)}{s.cancelAtPeriodEnd ? " (cancels)" : ""}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => setSelected(s.companyId)} data-testid={`sub-manage-${s.companyId}`}>Manage</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex items-center justify-between p-4 border-t border-border text-sm text-muted-foreground">
            <span data-testid="sub-total">{total.toLocaleString()} subscription{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span>Page {page} of {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="provider-card">
          <CardHeader>
            <CardTitle>Online billing provider</CardTitle>
            <CardDescription>Configuration state only — no secret values are shown.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {providerStatus.data ? (
              <>
                <div>Provider: <Badge variant="outline" className="capitalize">{providerStatus.data.provider}</Badge> {providerStatus.data.available ? "configured" : `not available (${providerStatus.data.unavailableReason ?? "not configured"})`}</div>
                <div>Tenant self-service checkout: {providerStatus.data.selfServiceCheckoutEnabled ? "enabled" : "disabled"}</div>
                <div>Automatic tax: {providerStatus.data.automaticTax ? "enabled" : "off (tax policy not approved)"}</div>
                <div>Default trial for new companies: {providerStatus.data.trialDays} days</div>
              </>
            ) : (
              <div className="text-muted-foreground">Loading…</div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="prices-card">
          <CardHeader>
            <CardTitle>Provider price mappings</CardTitle>
            <CardDescription>Register a provider price id for a plan. Interval, currency and amount are retrieved from the provider — never typed here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value={priceForm.planId} onValueChange={(v) => setPriceForm({ ...priceForm, planId: v })}>
                <SelectTrigger className="sm:w-[160px]" data-testid="price-plan"><SelectValue /></SelectTrigger>
                <SelectContent>{PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
              </Select>
              <Input placeholder="price_…" value={priceForm.providerPriceId} onChange={(e) => setPriceForm({ ...priceForm, providerPriceId: e.target.value })} data-testid="price-id" />
              <Button onClick={() => void registerPrice()} disabled={busy || !providerStatus.data?.available || priceForm.providerPriceId.trim().length < 6} data-testid="price-register">Register</Button>
            </div>
            {(prices.data?.prices.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="prices-empty">No prices registered. Online checkout stays unavailable until a verified price exists.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Interval</TableHead>
                      <TableHead>Ref</TableHead>
                      <TableHead className="text-right">Active</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {prices.data?.prices.map((p) => (
                      <TableRow key={p.id} data-testid={`price-row-${p.id}`}>
                        <TableCell className="capitalize">{p.planId}</TableCell>
                        <TableCell>{money(p.unitAmountMinor, p.currency)}</TableCell>
                        <TableCell>{p.intervalCount > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval}</TableCell>
                        <TableCell className="font-mono text-xs">{p.providerPriceRef ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => void togglePrice(p.id, !p.active)}>{p.active ? "Deactivate" : "Activate"}</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Detail / manage dialog ───────────────────────────────────────── */}
      <Dialog open={selected != null} onOpenChange={(o) => !o && !busy && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="sub-detail">
          {/* Title + description are always rendered (accessible name while the detail loads). */}
          <DialogHeader>
            <DialogTitle>{d ? (d.companyName ?? `Company ${d.companyId}`) : "Subscription"}</DialogTitle>
            <DialogDescription>
              {d ? (
                <>
                  <span className="capitalize">{d.plan}</span> · {STATUS_LABEL[d.status] ?? d.status} · {d.billingSource === "stripe" ? "Stripe-managed" : "manual"} · access {d.accessMode.replace("_", "-")}
                </>
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
                  {["contacts", "events", "admins", "employees", "scans", "storageMb"].map((k) => (
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
    </div>
  );
}
