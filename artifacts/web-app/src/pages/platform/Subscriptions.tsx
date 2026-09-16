import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePlatformListSubscriptions,
  usePlatformSubscriptionMetrics,
  usePlatformBillingStatus,
  usePlatformListPrices,
  usePlatformRegisterPrice,
  usePlatformUpdatePrice,
  getPlatformListSubscriptionsQueryKey,
  getPlatformSubscriptionMetricsQueryKey,
  getPlatformListPricesQueryKey,
  type PlatformSubscriptionListItem,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, MetricCard, StatusBadge, TableSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { CreditCard, Search, Building2 } from "lucide-react";
import { Link } from "wouter";
import { SubscriptionManager, STATUSES, PLANS, STATUS_LABEL, statusTone, fmt, errMessage, invalidateCompanyQueries } from "@/components/platform/SubscriptionManager";

// Batch 20 — truthful Platform Subscriptions screen. Everything on this page is
// real API data: canonical subscription rows with filters + pagination, counts by
// canonical state / plan / billing source, revenue only when it can be computed
// from verified provider prices (otherwise "Unavailable" + reason), and manual
// lifecycle actions with confirmation dialogs. No fake rows, no random numbers,
// no growth percentages, no non-functional buttons.
// Batch 21 — the detail / lifecycle dialog lives in components/platform/
// SubscriptionManager (shared with the Companies list and the tenant detail
// page); `?company=<id>` deep-links straight into it.

const RETURN_URL_REASON: Record<string, string> = {
  RETURN_URL_MISSING: "not set (BILLING_RETURN_URL / APP_BASE_URL)",
  RETURN_URL_INVALID: "invalid (must be an absolute URL without credentials, query or fragment)",
  RETURN_URL_INSECURE: "insecure (production requires HTTPS)",
  RETURN_URL_LOCALHOST: "localhost is not allowed in production",
};
const REVENUE_REASON: Record<string, string> = {
  NO_VERIFIED_PRICES: "No provider prices have been registered yet.",
  NO_ACTIVE_PROVIDER_SUBSCRIPTIONS: "No active online subscriptions.",
  UNPRICED_SUBSCRIPTIONS: "Active online subscriptions are not bound to a registered price.",
  MIXED_CURRENCIES: "Active subscriptions use more than one currency.",
  PARTIAL_UNPRICED: "Some active subscriptions are not bound to a registered price.",
};

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function companyFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get("company");
  const id = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function PlatformSubscriptions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState("all");
  const [plan, setPlan] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(() => companyFromSearch(searchString));
  const [busy, setBusy] = useState(false);
  const [priceForm, setPriceForm] = useState({ planId: "starter", providerPriceId: "" });
  const limit = 20;

  // Deep link (Companies list / tenant detail → "Manage subscription").
  useEffect(() => {
    const fromUrl = companyFromSearch(searchString);
    if (fromUrl != null) setSelected(fromUrl);
  }, [searchString]);
  const closeManager = () => {
    setSelected(null);
    if (companyFromSearch(searchString) != null) navigate("/platform/subscriptions", { replace: true });
  };

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
  const registerPriceMutation = usePlatformRegisterPrice();
  const updatePriceMutation = usePlatformUpdatePrice();

  const registerPrice = async () => {
    setBusy(true);
    try {
      await registerPriceMutation.mutateAsync({ data: { planId: priceForm.planId as (typeof PLANS)[number], providerPriceId: priceForm.providerPriceId.trim() } });
      toast({ title: "Price registered" });
      setPriceForm({ ...priceForm, providerPriceId: "" });
      void queryClient.invalidateQueries({ queryKey: getPlatformListPricesQueryKey() });
      invalidateCompanyQueries(queryClient);
    } catch (err) {
      toast({ title: "Price registration failed", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const togglePrice = async (id: number, active: boolean) => {
    try {
      await updatePriceMutation.mutateAsync({ id, data: { active } });
      void queryClient.invalidateQueries({ queryKey: getPlatformListPricesQueryKey() });
      invalidateCompanyQueries(queryClient);
    } catch (err) {
      toast({ title: "Price update failed", description: errMessage(err), variant: "destructive" });
    }
  };

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const revenue = metrics.data?.revenue;
  const byStatus = new Map((metrics.data?.byStatus ?? []).map((s) => [s.status, s.count]));

  return (
    <div className="space-y-6" data-testid="platform-subscriptions">
      <PageHeader
        title="Subscriptions"
        description="Canonical subscription state for every company — manual lifecycle controls and provider billing."
        actions={<Button asChild variant="outline"><Link href="/platform/companies"><Building2 className="mr-2 h-4 w-4" />Companies</Link></Button>}
      />

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
          ) : list.isError ? (
            <div className="p-6"><ErrorState title="Subscriptions could not be loaded" description={errMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => void list.refetch()}>Retry</Button>} /></div>
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
                      <TableCell className="font-medium"><Link href={`/platform/companies/${s.companyId}`} className="hover:underline">{s.companyName}</Link></TableCell>
                      <TableCell className="capitalize">{s.plan}</TableCell>
                      <TableCell><StatusBadge tone={statusTone(s.status)} showDot>{STATUS_LABEL[s.status] ?? s.status}</StatusBadge></TableCell>
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
                <div data-testid="provider-mode">Provider mode: {providerStatus.data.stripeMode ? <Badge variant={providerStatus.data.stripeMode === "live" ? "default" : "secondary"}>{providerStatus.data.stripeMode}</Badge> : <span className="text-destructive">invalid setting</span>}</div>
                <div data-testid="provider-return-url">Billing return URL: {providerStatus.data.returnUrlConfigured ? "configured" : <span className="text-destructive">{RETURN_URL_REASON[providerStatus.data.returnUrlReason ?? ""] ?? "not usable"} — tenant checkout and portal are unavailable until fixed</span>}</div>
              </>
            ) : providerStatus.isError ? (
              <ErrorState title="Provider status unavailable" description={errMessage(providerStatus.error)} />
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
                        <TableCell className="font-mono text-xs">{p.providerPriceRef ?? "—"}<span className="ml-2 font-sans text-muted-foreground">({p.providerMode})</span></TableCell>
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

      <SubscriptionManager companyId={selected} onClose={closeManager} />
    </div>
  );
}
