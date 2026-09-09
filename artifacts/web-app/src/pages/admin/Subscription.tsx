import React, { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetCurrentSubscription,
  useListPlans,
  useCreateCheckoutSession,
  useCreateBillingPortalSession,
  getGetCurrentSubscriptionQueryKey,
  getListPlansQueryKey,
  ApiError,
  type Subscription,
  type ResourceUsage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader, ErrorState, CardGridSkeleton } from "@/components/ds";
import { useAuth } from "@/contexts/AuthContext";
import { subscriptionAccess } from "@/components/billing/permissions";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { CreditCard, ExternalLink, ShieldCheck, Info } from "lucide-react";

// Batch 20 — truthful tenant subscription page. Every value comes from the
// canonical subscription projection (GET /subscriptions/current). No invented
// prices, renewal dates or upgrade buttons: Checkout appears only when an active
// provider-verified price exists and the provider is configured; the Billing
// Portal only for provider-managed subscriptions with a verified customer.

const STATUS_LABEL: Record<string, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  cancelled: "Cancelled",
  expired: "Expired",
  suspended: "Suspended",
};

const ACCESS_LABEL: Record<string, string> = { full: "Full access", read_only: "Read-only", blocked: "Blocked" };

const RESOURCE_LABEL: Record<string, string> = {
  contacts: "Contacts",
  events: "Events",
  admins: "Administrators",
  employees: "Employees",
  scans: "Scans (this period)",
  storageMb: "Storage",
};

const CHECKOUT_REASON: Record<string, string> = {
  PROVIDER_UNAVAILABLE: "Online checkout is not available on this platform.",
  CHECKOUT_DISABLED: "Online checkout is not enabled.",
  NO_ACTIVE_PRICES: "No online plan prices are available yet.",
  LIVE_SUBSCRIPTION_EXISTS: "This company already has an online subscription — manage it in the billing portal.",
  STATUS_NOT_ELIGIBLE: "Online checkout is not available in the current subscription state.",
};
const PORTAL_REASON: Record<string, string> = {
  PROVIDER_UNAVAILABLE: "The billing portal is not available on this platform.",
  NOT_PROVIDER_MANAGED: "This subscription is managed by the platform operator.",
  NO_PROVIDER_CUSTOMER: "No online billing account exists for this company yet.",
  STATUS_NOT_ELIGIBLE: "The billing portal is not available in the current subscription state.",
};

export { subscriptionAccess } from "@/components/billing/permissions";

function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active" || status === "trialing") return "default";
  if (status === "past_due" || status === "cancelled") return "secondary";
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

function UsageRow({ r }: { r: ResourceUsage }) {
  const pct = r.limit && r.limit > 0 ? Math.min(100, Math.round((r.used / r.limit) * 100)) : null;
  return (
    <TableRow data-testid={`usage-row-${r.resource}`}>
      <TableCell className="font-medium">{RESOURCE_LABEL[r.resource] ?? r.resource}</TableCell>
      <TableCell className="text-right tabular-nums">{r.measurable ? r.used.toLocaleString() : "Not measured"}</TableCell>
      <TableCell className="text-right tabular-nums">
        {!r.measurable ? "Not enforced" : r.limit == null ? "Unlimited" : r.limit.toLocaleString()}
      </TableCell>
      <TableCell className="w-[180px]">
        {r.measurable && r.limit != null ? (
          <div className="flex items-center gap-2">
            <Progress value={pct ?? 0} className="h-2" />
            <span className="text-xs text-muted-foreground w-10 text-right">{pct}%</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{r.measurable ? "No limit configured" : "Storage usage is not metered"}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function AdminSubscription() {
  const { user } = useAuth();
  const access = subscriptionAccess(user as never);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [location] = useLocation();
  const { data: sub, isLoading, isError, refetch } = useGetCurrentSubscription({ query: { enabled: access.canView, queryKey: getGetCurrentSubscriptionQueryKey() } });
  const { data: plans } = useListPlans({ query: { enabled: access.canView && !!sub?.billing.checkoutAvailable, queryKey: getListPlansQueryKey() } });
  const checkout = useCreateCheckoutSession();
  const portal = useCreateBillingPortalSession();
  const [busy, setBusy] = useState<string | null>(null);

  const checkoutFlag = useMemo(() => {
    const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    return q?.get("checkout");
  }, [location]);

  if (!access.canView) {
    return (
      <div className="space-y-6 max-w-5xl">
        <PageHeader title="Subscription" description="Plan, status and usage for your company" />
        <ErrorState title="No access" description="You do not have permission to view billing information." />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <PageHeader title="Subscription" description="Plan, status and usage for your company" />
        <CardGridSkeleton cards={3} />
      </div>
    );
  }
  if (isError || !sub) {
    return (
      <div className="space-y-6 max-w-5xl">
        <PageHeader title="Subscription" description="Plan, status and usage for your company" />
        <ErrorState
          title="Could not load the subscription"
          description="Please try again."
          action={<Button variant="outline" onClick={() => void refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  const s: Subscription = sub;
  const period = s.currentPeriodEndsAt ? `Current period ends ${fmt(s.currentPeriodEndsAt)}` : s.status === "trialing" && s.trialExpiresAt ? `Trial ends ${fmt(s.trialExpiresAt)}` : null;
  const startCheckout = async (planPriceId: number) => {
    setBusy(`price-${planPriceId}`);
    try {
      const r = await checkout.mutateAsync({ data: { planPriceId } });
      window.location.assign(r.url);
    } catch (err) {
      const code = err instanceof ApiError ? (err.data as { code?: string } | null)?.code : undefined;
      toast({ title: "Checkout unavailable", description: code === "PROVIDER_ERROR" ? "The payment provider could not start checkout. Please try again." : CHECKOUT_REASON[code ?? ""] ?? "Checkout is not available right now.", variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: getGetCurrentSubscriptionQueryKey() });
    } finally {
      setBusy(null);
    }
  };
  const openPortal = async () => {
    setBusy("portal");
    try {
      const r = await portal.mutateAsync();
      window.location.assign(r.url);
    } catch (err) {
      const code = err instanceof ApiError ? (err.data as { code?: string } | null)?.code : undefined;
      toast({ title: "Billing portal unavailable", description: PORTAL_REASON[code ?? ""] ?? "The billing portal is not available right now.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl" data-testid="subscription-page">
      <PageHeader title="Subscription" description="Plan, status and usage for your company" />

      {checkoutFlag === "success" && (
        <Alert data-testid="checkout-returned">
          <Info className="h-4 w-4" />
          <AlertTitle>Checkout completed</AlertTitle>
          <AlertDescription>Your subscription updates once the payment provider confirms it. This page reflects the confirmed state only.</AlertDescription>
        </Alert>
      )}
      {checkoutFlag === "cancelled" && (
        <Alert data-testid="checkout-returned">
          <Info className="h-4 w-4" />
          <AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>Nothing was changed.</AlertDescription>
        </Alert>
      )}
      {s.accessMode !== "full" && s.accessMessage && (
        <Alert variant={s.accessMode === "blocked" ? "destructive" : "default"} data-testid="access-banner">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>{ACCESS_LABEL[s.accessMode]}</AlertTitle>
          <AlertDescription>{s.accessMessage}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card data-testid="plan-card">
          <CardHeader className="pb-2">
            <CardDescription>Plan</CardDescription>
            <CardTitle className="text-2xl capitalize" data-testid="plan-name">{s.plan}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s.billing.managedByPlatform ? "Managed by the platform operator" : "Managed through online billing"}
          </CardContent>
        </Card>
        <Card data-testid="status-card">
          <CardHeader className="pb-2">
            <CardDescription>Status</CardDescription>
            <CardTitle className="flex items-center gap-2">
              <Badge variant={statusTone(s.status)} className="text-sm px-3 py-1" data-testid="status-badge">{STATUS_LABEL[s.status] ?? s.status}</Badge>
              <span className="text-sm font-normal text-muted-foreground" data-testid="access-mode">{ACCESS_LABEL[s.accessMode]}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            <div data-testid="period-line">{period ?? "No billing period"}</div>
            {s.cancelAtPeriodEnd && <div data-testid="cancel-at-period-end">Cancels at the end of the current period</div>}
            <div>Billing source: <span className="capitalize">{s.billingSource === "stripe" ? "online (Stripe)" : "manual"}</span></div>
          </CardContent>
        </Card>
        <Card data-testid="billing-card">
          <CardHeader className="pb-2">
            <CardDescription>Billing</CardDescription>
            <CardTitle className="text-base flex items-center gap-2"><CreditCard className="h-4 w-4" /> {s.billing.managedByPlatform ? "Platform-managed" : "Online billing"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {s.billing.portalAvailable ? (
              access.canManage ? (
                <Button size="sm" onClick={() => void openPortal()} disabled={busy !== null} data-testid="portal-button">
                  <ExternalLink className="mr-2 h-4 w-4" /> Manage billing
                </Button>
              ) : (
                <p className="text-muted-foreground">Billing can be managed by an administrator with billing permission.</p>
              )
            ) : (
              <p className="text-muted-foreground" data-testid="portal-unavailable">{PORTAL_REASON[s.billing.portalUnavailableReason ?? ""] ?? "The billing portal is not available."}</p>
            )}
            {!s.billing.checkoutAvailable && s.billing.checkoutUnavailableReason && s.billing.checkoutUnavailableReason !== "LIVE_SUBSCRIPTION_EXISTS" && (
              <p className="text-muted-foreground" data-testid="checkout-unavailable">{CHECKOUT_REASON[s.billing.checkoutUnavailableReason] ?? "Online checkout is not available."}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {s.billing.checkoutAvailable && access.canManage && (
        <Card data-testid="checkout-card">
          <CardHeader>
            <CardTitle>Choose an online plan</CardTitle>
            <CardDescription>Prices are verified with the payment provider. Your subscription changes only after the provider confirms payment.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {(plans ?? [])
                .flatMap((p) => p.prices.filter((pr) => pr.active).map((pr) => ({ plan: p, price: pr })))
                .map(({ plan, price }) => (
                  <div key={price.id} className="rounded-lg border border-border p-4 flex items-center justify-between gap-3" data-testid={`price-option-${price.id}`}>
                    <div>
                      <div className="font-medium">{plan.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {money(price.unitAmountMinor, price.currency)} / {price.intervalCount > 1 ? `${price.intervalCount} ${price.interval}s` : price.interval}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => void startCheckout(price.id)} disabled={busy !== null} data-testid={`checkout-button-${price.id}`}>
                      {busy === `price-${price.id}` ? "Opening…" : "Continue to checkout"}
                    </Button>
                  </div>
                ))}
              {(plans ?? []).every((p) => p.prices.filter((pr) => pr.active).length === 0) && (
                <p className="text-sm text-muted-foreground">No online prices are available.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="usage-card">
        <CardHeader>
          <CardTitle>Usage and limits</CardTitle>
          <CardDescription>
            Measured {fmt(s.usage.window.startsAt)} – {fmt(s.usage.window.endsAt)} for scans; other resources are counted live. Limits marked “Unlimited” have not been configured.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead className="text-right">Limit</TableHead>
                  <TableHead>Progress</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.usage.resources.map((r) => (
                  <UsageRow key={r.resource} r={r} />
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
