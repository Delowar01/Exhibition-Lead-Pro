import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import {
  usePlatformListPlans,
  usePlatformGetPlan,
  usePlatformPreviewPlanLimits,
  usePlatformListSubscriptions,
  getPlatformListPlansQueryKey,
  getPlatformGetPlanQueryKey,
  getPlatformPreviewPlanLimitsQueryKey,
  getPlatformListSubscriptionsQueryKey,
  type PlatformPlanOverview,
  type PlatformEffectiveLimitPreviewRow,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, MetricCard, StatusBadge, TableSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { Layers, CreditCard, SlidersHorizontal, Building2, Search, Lock } from "lucide-react";
import { STATUS_LABEL, LIMIT_RESOURCES, statusTone, fmt, errMessage } from "@/components/platform/SubscriptionManager";

// Batch 39 — Plan Builder foundation (PB-1): READ-ONLY platform-owner plan catalog.
//
// Everything on this page is real API data over the EXISTING entities: the five
// fixed plans with their default limits, feature flags, trial policy, verified
// provider price mappings, canonical subscription counts and per-tenant override
// counts, plus a read-only effective-limit preview computed by the SAME resolver
// and usage counter the product enforces with. There is deliberately no edit
// control: a published plan's entitlements are shared by every subscriber, so
// in-place edits are unsafe; the versioned Plan Builder (drafts → immutable
// published versions, PB-2) is pending the owner's data-model approval.
// Per-tenant limit overrides stay where they are managed today (Subscriptions).

const RESOURCE_LABEL: Record<(typeof LIMIT_RESOURCES)[number], string> = {
  contacts: "Contacts",
  events: "Events",
  admins: "Admins",
  employees: "Employees",
  scans: "Scans",
  storageMb: "Storage (MB)",
};
const ACCESS_LABEL: Record<string, string> = { full: "Full access", read_only: "Read-only", blocked: "Blocked" };
const SOURCE_LABEL: Record<string, string> = { override: "Tenant override", plan: "Plan default", unlimited: "Unlimited" };

function limitText(n: number | null | undefined): string {
  return n == null ? "Unlimited" : n.toLocaleString();
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function fromSearch(search: string, key: string): string | null {
  const v = new URLSearchParams(search).get(key);
  return v && v.trim() ? v.trim() : null;
}

export default function PlatformPlans() {
  const search = useSearch();
  const [selected, setSelected] = useState<string | null>(() => fromSearch(search, "plan"));
  const [previewPlan, setPreviewPlan] = useState<string>(() => fromSearch(search, "plan") ?? "");
  const [previewCompany, setPreviewCompany] = useState<number | null>(() => {
    const raw = fromSearch(search, "company");
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [tenantSearch, setTenantSearch] = useState("");

  const catalog = usePlatformListPlans({ query: { queryKey: getPlatformListPlansQueryKey() } });
  const detail = usePlatformGetPlan(selected ?? "", { query: { enabled: !!selected, queryKey: getPlatformGetPlanQueryKey(selected ?? "") } });
  const tenantParams = useMemo(() => ({ search: tenantSearch.trim(), page: 1, limit: 8 }), [tenantSearch]);
  const tenants = usePlatformListSubscriptions(tenantParams, { query: { enabled: tenantParams.search.length >= 2, queryKey: getPlatformListSubscriptionsQueryKey(tenantParams) } });
  const preview = usePlatformPreviewPlanLimits(previewPlan, previewCompany ?? 0, {
    query: { enabled: !!previewPlan && !!previewCompany, queryKey: getPlatformPreviewPlanLimitsQueryKey(previewPlan, previewCompany ?? 0) },
  });

  const plans: PlatformPlanOverview[] = catalog.data?.plans ?? [];
  // Default the preview plan to the selected plan (or the first plan) once the catalog is known.
  useEffect(() => {
    if (!previewPlan && plans.length) setPreviewPlan(selected && plans.some((p) => p.id === selected) ? selected : plans[0].id);
  }, [plans, previewPlan, selected]);

  const totals = useMemo(
    () => ({
      plans: plans.length,
      activePlans: plans.filter((p) => p.isActive).length,
      subscriptions: plans.reduce((a, p) => a + p.subscriptions.total, 0),
      prices: plans.reduce((a, p) => a + p.activePriceCount, 0),
      overrides: plans.reduce((a, p) => a + p.subscriptions.withOverrides, 0),
    }),
    [plans],
  );

  const pick = (planId: string) => {
    setSelected(planId);
    setPreviewPlan(planId);
  };

  return (
    <div className="space-y-6" data-testid="platform-plans">
      <PageHeader
        title="Plans"
        description="Read-only plan catalog: the fixed plans, their default limits and feature flags, verified provider prices, the trial policy and live subscription counts."
        breadcrumbs={[{ label: "Platform", href: "/platform" }, { label: "Plans" }]}
        actions={
          <StatusBadge tone="info" showDot={false}>
            <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
            Read-only
          </StatusBadge>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Plans" value={catalog.isLoading ? "…" : totals.plans} icon={Layers} footer={catalog.data ? `${totals.activePlans} active · ${totals.plans - totals.activePlans} inactive` : undefined} />
        <MetricCard label="Subscriptions" value={catalog.isLoading ? "…" : totals.subscriptions.toLocaleString()} icon={Building2} footer="Canonical subscription rows across all plans" />
        <MetricCard label="Verified prices" value={catalog.isLoading ? "…" : totals.prices} icon={CreditCard} footer={catalog.data ? `Provider: ${catalog.data.provider.kind}${catalog.data.provider.stripeMode ? ` (${catalog.data.provider.stripeMode})` : ""} · ${catalog.data.provider.available ? "available" : "not configured"}` : undefined} />
        <MetricCard label="Tenants with overrides" value={catalog.isLoading ? "…" : totals.overrides} icon={SlidersHorizontal} footer="Per-tenant limit overrides (managed in Subscriptions)" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan catalog</CardTitle>
          <CardDescription>Default limits apply to every subscriber of a plan unless the tenant carries its own override. Null limits are unlimited.</CardDescription>
        </CardHeader>
        <CardContent>
          {catalog.isLoading ? (
            <TableSkeleton rows={5} />
          ) : catalog.isError ? (
            <ErrorState title="Plans could not be loaded" description={errMessage(catalog.error)} action={<Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>Retry</Button>} />
          ) : plans.length === 0 ? (
            <EmptyState icon={Layers} title="No plans" description="The plan catalog is empty." />
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="plan-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Trial</TableHead>
                    {LIMIT_RESOURCES.map((r) => (
                      <TableHead key={r} className="text-right">{RESOURCE_LABEL[r]}</TableHead>
                    ))}
                    <TableHead className="text-right">Prices</TableHead>
                    <TableHead className="text-right">Subscriptions</TableHead>
                    <TableHead className="text-right">Overrides</TableHead>
                    <TableHead className="text-right">Versioning</TableHead>
                    <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.id} data-testid={`plan-row-${p.id}`} data-state={selected === p.id ? "selected" : undefined}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "Active" : "Inactive"}</StatusBadge>
                          {p.seeded && <Badge variant="outline">seeded</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>{p.trialDays} d</TableCell>
                      {LIMIT_RESOURCES.map((r) => (
                        <TableCell key={r} className="text-right tabular-nums" data-testid={`plan-limit-${p.id}-${r}`}>{limitText(p.limits[r])}</TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums">{p.activePriceCount}{p.prices.length > p.activePriceCount ? <span className="text-muted-foreground"> / {p.prices.length}</span> : null}</TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`plan-subs-${p.id}`}>{p.subscriptions.total.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.subscriptions.withOverrides.toLocaleString()}</TableCell>
                      <TableCell className="text-right"><Badge variant="secondary">{p.versioning === "not_versioned" ? "not versioned" : p.versioning}</Badge></TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => pick(p.id)} data-testid={`plan-details-${p.id}`}>Details</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="mt-4 flex items-start gap-2 text-sm text-muted-foreground" data-testid="plans-readonly-notice">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Published plan entitlements are shared by every subscriber and are not editable in place. Changing them safely requires the versioned Plan Builder (drafts and immutable published versions), which is pending approval. Per-tenant limit overrides are managed from <Link href="/platform/subscriptions" className="underline underline-offset-2">Subscriptions</Link>.
            </span>
          </p>
        </CardContent>
      </Card>

      {catalog.data && (
        <Card data-testid="trial-policy-card">
          <CardHeader>
            <CardTitle>Trial policy</CardTitle>
            <CardDescription>How trials behave today for every plan (platform-wide; the per-plan trial length is the plan's own setting above).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><div className="text-muted-foreground">Default trial length</div><div className="font-medium tabular-nums">{catalog.data.trialPolicy.defaultTrialDays} days</div></div>
            <div><div className="text-muted-foreground">Configured trial length</div><div className="font-medium tabular-nums">{catalog.data.trialPolicy.configuredTrialDays} days</div></div>
            <div><div className="text-muted-foreground">End of trial</div><div className="font-medium">{catalog.data.trialPolicy.endOfTrialOutcome === "blocked" ? "Blocked (no read-only grace)" : catalog.data.trialPolicy.endOfTrialOutcome}</div></div>
            <div><div className="text-muted-foreground">Manual trial expiry sweep</div><div className="font-medium">{catalog.data.trialPolicy.manualTrialExpirySweep ? "Enabled" : "Disabled"}</div></div>
            <p className="text-muted-foreground sm:col-span-2 lg:col-span-4">{catalog.data.trialPolicy.rule}</p>
          </CardContent>
        </Card>
      )}

      {selected && (
        <Card data-testid="plan-detail">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle data-testid="plan-detail-title">{detail.data?.name ?? selected}</CardTitle>
                <CardDescription>{detail.data?.description ?? "Plan details, limits, features, verified prices and subscription counts."}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)} data-testid="plan-detail-close">Close</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {detail.isLoading ? (
              <TableSkeleton rows={6} />
            ) : detail.isError ? (
              <ErrorState title="Plan could not be loaded" description={errMessage(detail.error)} action={<Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Retry</Button>} />
            ) : detail.data ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge tone={detail.data.isActive ? "success" : "neutral"}>{detail.data.isActive ? "Active" : "Inactive"}</StatusBadge>
                  {detail.data.seeded && <Badge variant="outline">seeded catalog plan</Badge>}
                  <Badge variant="secondary">not versioned</Badge>
                  <span className="text-muted-foreground">Sort order {detail.data.sortOrder} · Trial {detail.data.trialDays} days · Updated {fmt(detail.data.updatedAt)}</span>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Default limits</h3>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Resource</TableHead>
                          <TableHead className="text-right">Plan default</TableHead>
                          <TableHead className="text-right">Tenants overriding</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {LIMIT_RESOURCES.map((r) => (
                          <TableRow key={r} data-testid={`limit-row-${r}`}>
                            <TableCell>{RESOURCE_LABEL[r]}</TableCell>
                            <TableCell className="text-right tabular-nums" data-testid={`limit-default-${r}`}>{limitText(detail.data!.limits[r])}</TableCell>
                            <TableCell className="text-right tabular-nums" data-testid={`limit-overrides-${r}`}>{detail.data!.overrides.byResource[r]}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p className="mt-2 text-xs text-muted-foreground">Effective limit = tenant override ?? plan default ?? unlimited (single resolver). {detail.data.overrides.tenantsWithAnyOverride} tenant{detail.data.overrides.tenantsWithAnyOverride === 1 ? "" : "s"} on this plan carry at least one override.</p>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <h3 className="mb-2 text-sm font-semibold">Features</h3>
                      {Object.keys(detail.data.features).length === 0 ? (
                        <div data-testid="plan-features-empty">
                          <EmptyState icon={Layers} title="No feature flags" description="This plan carries no feature flags; functionality is not gated by plan today." className="py-6" />
                        </div>
                      ) : (
                        <ul className="flex flex-wrap gap-2" data-testid="plan-features">
                          {Object.entries(detail.data.features).map(([k, v]) => (
                            <li key={k}><Badge variant={v ? "default" : "outline"}>{k}: {v ? "on" : "off"}</Badge></li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h3 className="mb-2 text-sm font-semibold">Subscriptions</h3>
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3" data-testid="plan-counts">
                        <div className="rounded-md border p-2"><div className="text-muted-foreground">Total</div><div className="font-medium tabular-nums" data-testid="plan-count-total">{detail.data.subscriptions.total}</div></div>
                        <div className="rounded-md border p-2"><div className="text-muted-foreground">Manual</div><div className="font-medium tabular-nums">{detail.data.subscriptions.byBillingSource.manual}</div></div>
                        <div className="rounded-md border p-2"><div className="text-muted-foreground">Stripe</div><div className="font-medium tabular-nums">{detail.data.subscriptions.byBillingSource.stripe}</div></div>
                        {(Object.entries(detail.data.subscriptions.byStatus) as [string, number][]).map(([s, n]) => (
                          <div key={s} className="rounded-md border p-2" data-testid={`plan-count-${s}`}>
                            <div className="flex items-center gap-1 text-muted-foreground"><StatusBadge tone={statusTone(s)}>{STATUS_LABEL[s] ?? s}</StatusBadge></div>
                            <div className="font-medium tabular-nums">{n}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">Provider price mappings</h3>
                  {detail.data.prices.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="plan-prices-empty">No verified provider price is registered for this plan. Online checkout for it stays unavailable until one exists (register prices from Subscriptions).</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Amount</TableHead>
                            <TableHead>Interval</TableHead>
                            <TableHead>Ref</TableHead>
                            <TableHead>Mode</TableHead>
                            <TableHead>Verified</TableHead>
                            <TableHead className="text-right">Active</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.data.prices.map((p) => (
                            <TableRow key={p.id} data-testid={`price-row-${p.id}`}>
                              <TableCell className="tabular-nums">{money(p.unitAmountMinor, p.currency)}</TableCell>
                              <TableCell>{p.intervalCount > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval}</TableCell>
                              <TableCell className="font-mono text-xs">{p.providerPriceRef ?? "—"}</TableCell>
                              <TableCell><Badge variant={p.providerMode === "live" ? "default" : "secondary"}>{p.providerMode}</Badge></TableCell>
                              <TableCell>{fmt(p.verifiedAt)}</TableCell>
                              <TableCell className="text-right"><StatusBadge tone={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Inactive"}</StatusBadge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card data-testid="preview-card">
        <CardHeader>
          <CardTitle>Effective-limit preview</CardTitle>
          <CardDescription>What a tenant's effective limits would be under a plan, computed by the same resolver and usage counter the product enforces with. Nothing is changed by previewing.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={previewPlan} onValueChange={setPreviewPlan} disabled={plans.length === 0}>
              <SelectTrigger className="sm:w-[200px]" data-testid="preview-plan"><SelectValue placeholder="Plan" /></SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input placeholder="Search tenant by company name…" className="pl-8" value={tenantSearch} onChange={(e) => setTenantSearch(e.target.value)} data-testid="preview-search" />
            </div>
          </div>

          {tenantParams.search.length >= 2 && (
            <div className="rounded-md border" data-testid="preview-results">
              {tenants.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">Searching…</p>
              ) : tenants.isError ? (
                <p className="p-3 text-sm text-destructive">{errMessage(tenants.error)}</p>
              ) : (tenants.data?.subscriptions.length ?? 0) === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No tenant matches.</p>
              ) : (
                <ul className="divide-y">
                  {tenants.data!.subscriptions.map((s) => (
                    <li key={s.companyId} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                      <span>
                        <span className="font-medium">{s.companyName}</span>
                        <span className="ml-2 text-muted-foreground">#{s.companyId} · {s.plan} · {STATUS_LABEL[s.status] ?? s.status} · {s.billingSource}</span>
                      </span>
                      <Button variant={previewCompany === s.companyId ? "default" : "outline"} size="sm" onClick={() => setPreviewCompany(s.companyId)} data-testid={`preview-pick-${s.companyId}`}>
                        {previewCompany === s.companyId ? "Selected" : "Preview"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!previewCompany ? (
            <p className="text-sm text-muted-foreground" data-testid="preview-empty">Pick a tenant to preview its effective limits under the selected plan.</p>
          ) : preview.isLoading ? (
            <TableSkeleton rows={6} />
          ) : preview.isError ? (
            <ErrorState title="Preview unavailable" description={errMessage(preview.error)} action={<Button variant="outline" size="sm" onClick={() => void preview.refetch()}>Retry</Button>} />
          ) : preview.data ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="preview-summary">
                <span className="font-medium">{preview.data.companyName ?? `Company #${preview.data.companyId}`}</span>
                <span className="text-muted-foreground">#{preview.data.companyId}</span>
                <StatusBadge tone={statusTone(preview.data.status)}>{STATUS_LABEL[preview.data.status] ?? preview.data.status}</StatusBadge>
                <Badge variant="outline">{ACCESS_LABEL[preview.data.accessMode] ?? preview.data.accessMode}</Badge>
                <Badge variant="outline">{preview.data.billingSource}</Badge>
                <span className="text-muted-foreground">
                  Current plan <span className="font-medium text-foreground">{preview.data.currentPlan}</span> → preview <span className="font-medium text-foreground">{preview.data.previewPlan}</span>
                  {preview.data.isCurrentPlan ? " (current plan)" : ""}
                </span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Resource</TableHead>
                      <TableHead className="text-right">Plan default</TableHead>
                      <TableHead className="text-right">Tenant override</TableHead>
                      <TableHead className="text-right">Effective</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Used</TableHead>
                      <TableHead className="text-right">Remaining</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.data.rows.map((r: PlatformEffectiveLimitPreviewRow) => (
                      <TableRow key={r.resource} data-testid={`preview-row-${r.resource}`}>
                        <TableCell>{RESOURCE_LABEL[r.resource]}</TableCell>
                        <TableCell className="text-right tabular-nums">{limitText(r.planDefault)}</TableCell>
                        <TableCell className="text-right tabular-nums" data-testid={`preview-override-${r.resource}`}>{r.override == null ? "—" : r.override.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums" data-testid={`preview-effective-${r.resource}`}>{limitText(r.effective)}</TableCell>
                        <TableCell><Badge variant={r.source === "override" ? "default" : "secondary"}>{SOURCE_LABEL[r.source] ?? r.source}</Badge></TableCell>
                        <TableCell className="text-right tabular-nums">{limitText(r.currentEffective)}</TableCell>
                        <TableCell className="text-right tabular-nums" data-testid={`preview-used-${r.resource}`}>{r.measurable ? r.used.toLocaleString() : "n/a"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.remaining == null ? "—" : r.remaining.toLocaleString()}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {r.changes && <StatusBadge tone="warning">changes</StatusBadge>}
                            {r.exceeds && <StatusBadge tone="destructive">usage exceeds limit</StatusBadge>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="preview-footnote">
                {preview.data.changedResources.length === 0 ? "No effective limit would change." : `Would change: ${preview.data.changedResources.join(", ")}.`}{" "}
                {preview.data.blockingResources.length > 0 ? `Usage already exceeds the previewed limit for: ${preview.data.blockingResources.join(", ")} (informational — the behaviour on over-limit plan changes is not yet decided).` : ""}{" "}
                Preview only — no subscription, plan or override was modified.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
