import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePlatformListPlans,
  usePlatformGetPlan,
  usePlatformPreviewPlanLimits,
  usePlatformPreviewPlanVersionLimits,
  usePlatformListPlanVersions,
  usePlatformListSubscriptions,
  usePlatformCreatePlan,
  usePlatformDuplicatePlan,
  usePlatformArchivePlan,
  getPlatformListPlansQueryKey,
  getPlatformGetPlanQueryKey,
  getPlatformPreviewPlanLimitsQueryKey,
  getPlatformPreviewPlanVersionLimitsQueryKey,
  getPlatformListPlanVersionsQueryKey,
  getPlatformListSubscriptionsQueryKey,
  type PlatformPlanOverview,
  type PlatformEffectiveLimitPreviewRow,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, MetricCard, StatusBadge, TableSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { Layers, CreditCard, SlidersHorizontal, Building2, Search, Lock, Plus, Copy, Archive } from "lucide-react";
import { STATUS_LABEL, LIMIT_RESOURCES, statusTone, fmt, errMessage } from "@/components/platform/SubscriptionManager";
import { PlanVersions, invalidatePlanQueries, versionLabel, stateLabel } from "@/components/platform/PlanVersions";

// Batch 39 laid the read-only foundation (catalog, detail, effective-limit
// preview over the SAME resolver the product enforces with). Batch 40 turns it
// into the versioned Plan Builder (PB-2): plans are created as drafts, edited,
// validated and published as IMMUTABLE versions; subscribers are pinned to the
// version they were assigned and are never moved by a publication; published
// versions can be retired (kept for their subscribers) and non-fixed plans with
// no subscribers can be archived. Every control below calls a platform_owner-
// only API action that is validated, serialized and audited server-side.
// Feature flags and the trial policy are stored/validated/previewed only — not
// enforced until PB-3. Per-tenant limit overrides stay in Subscriptions.

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
const PLAN_STATUS_LABEL: Record<string, string> = { draft: "Draft", published: "Published", archived: "Archived" };
const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

function planStatusTone(s: string): "success" | "warning" | "neutral" {
  return s === "published" ? "success" : s === "draft" ? "warning" : "neutral";
}
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
function versionCell(p: PlatformPlanOverview): string {
  if (p.versioning === "not_versioned" && !p.draft) return "not versioned";
  const parts: string[] = [];
  if (p.currentVersion) parts.push(`${versionLabel(p.currentVersion)} current`);
  if (p.draft) parts.push(`${versionLabel(p.draft)} draft`);
  if (p.retiredVersionCount > 0) parts.push(`${p.retiredVersionCount} retired`);
  return parts.join(" · ") || "not versioned";
}

export default function PlatformPlans() {
  const search = useSearch();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(() => fromSearch(search, "plan"));
  const [previewPlan, setPreviewPlan] = useState<string>(() => fromSearch(search, "plan") ?? "");
  const [previewVersion, setPreviewVersion] = useState<string>("current");
  const [previewCompany, setPreviewCompany] = useState<number | null>(() => {
    const raw = fromSearch(search, "company");
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [tenantSearch, setTenantSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ id: "", name: "", description: "" });
  const [dupOpen, setDupOpen] = useState(false);
  const [dupForm, setDupForm] = useState({ id: "", name: "" });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const catalog = usePlatformListPlans({ query: { queryKey: getPlatformListPlansQueryKey() } });
  const detail = usePlatformGetPlan(selected ?? "", { query: { enabled: !!selected, queryKey: getPlatformGetPlanQueryKey(selected ?? "") } });
  const tenantParams = useMemo(() => ({ search: tenantSearch.trim(), page: 1, limit: 8 }), [tenantSearch]);
  const tenants = usePlatformListSubscriptions(tenantParams, { query: { enabled: tenantParams.search.length >= 2, queryKey: getPlatformListSubscriptionsQueryKey(tenantParams) } });
  const previewVersions = usePlatformListPlanVersions(previewPlan, { query: { enabled: !!previewPlan, queryKey: getPlatformListPlanVersionsQueryKey(previewPlan) } });
  const previewVersionId = previewVersion === "current" ? null : Number(previewVersion);
  const previewCurrent = usePlatformPreviewPlanLimits(previewPlan, previewCompany ?? 0, {
    query: { enabled: !!previewPlan && !!previewCompany && previewVersionId == null, queryKey: getPlatformPreviewPlanLimitsQueryKey(previewPlan, previewCompany ?? 0) },
  });
  const previewPinned = usePlatformPreviewPlanVersionLimits(previewPlan, previewVersionId ?? 0, previewCompany ?? 0, {
    query: { enabled: !!previewPlan && !!previewCompany && previewVersionId != null, queryKey: getPlatformPreviewPlanVersionLimitsQueryKey(previewPlan, previewVersionId ?? 0, previewCompany ?? 0) },
  });
  const preview = previewVersionId == null ? previewCurrent : previewPinned;

  const createPlan = usePlatformCreatePlan();
  const duplicatePlan = usePlatformDuplicatePlan();
  const archivePlan = usePlatformArchivePlan();

  const plans: PlatformPlanOverview[] = catalog.data?.plans ?? [];
  // Default the preview plan to the selected plan (or the first plan) once the catalog is known.
  useEffect(() => {
    if (!previewPlan && plans.length) setPreviewPlan(selected && plans.some((p) => p.id === selected) ? selected : plans[0].id);
  }, [plans, previewPlan, selected]);
  useEffect(() => {
    setPreviewVersion("current");
  }, [previewPlan]);

  const totals = useMemo(
    () => ({
      plans: plans.length,
      published: plans.filter((p) => p.status === "published").length,
      drafts: plans.filter((p) => p.status === "draft").length,
      archived: plans.filter((p) => p.status === "archived").length,
      subscriptions: plans.reduce((a, p) => a + p.subscriptions.total, 0),
      unpinned: plans.reduce((a, p) => a + p.unpinnedSubscriptions, 0),
      prices: plans.reduce((a, p) => a + p.activePriceCount, 0),
      overrides: plans.reduce((a, p) => a + p.subscriptions.withOverrides, 0),
    }),
    [plans],
  );

  const pick = (planId: string) => {
    setSelected(planId);
    setPreviewPlan(planId);
  };
  const refresh = () => {
    void invalidatePlanQueries(queryClient);
  };

  const submitCreate = async () => {
    setBusy(true);
    try {
      const r = await createPlan.mutateAsync({ data: { id: createForm.id.trim(), name: createForm.name.trim(), description: createForm.description.trim() || null } });
      toast({ title: `Plan ${r.plan.id} created as a draft`, description: "Edit and publish its first version to make it assignable." });
      setCreateOpen(false);
      setCreateForm({ id: "", name: "", description: "" });
      refresh();
      pick(r.plan.id);
    } catch (err) {
      toast({ title: "Plan not created", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const submitDuplicate = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await duplicatePlan.mutateAsync({ planId: selected, data: { id: dupForm.id.trim(), ...(dupForm.name.trim() ? { name: dupForm.name.trim() } : {}) } });
      toast({ title: `Plan ${r.plan.id} created from ${selected}`, description: "Limits, features and trial policy were copied into a draft; provider prices are never copied." });
      setDupOpen(false);
      setDupForm({ id: "", name: "" });
      refresh();
      pick(r.plan.id);
    } catch (err) {
      toast({ title: "Plan not duplicated", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const submitArchive = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await archivePlan.mutateAsync({ planId: selected });
      toast({ title: `Plan ${selected} archived`, description: "It can no longer be assigned." });
      setArchiveOpen(false);
      refresh();
    } catch (err) {
      toast({ title: "Plan not archived", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const createIdOk = SLUG_RE.test(createForm.id.trim());
  const dupIdOk = SLUG_RE.test(dupForm.id.trim());

  return (
    <div className="space-y-6" data-testid="platform-plans">
      <PageHeader
        title="Plans"
        description="Plan catalog and versioned Plan Builder: drafts are edited and validated, then published as immutable versions; subscribers stay pinned to the version they were assigned."
        breadcrumbs={[{ label: "Platform", href: "/platform" }, { label: "Plans" }]}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="plan-create-open">
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            New plan
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Plans" value={catalog.isLoading ? "…" : totals.plans} icon={Layers} footer={catalog.data ? `${totals.published} published · ${totals.drafts} draft · ${totals.archived} archived` : undefined} />
        <MetricCard label="Subscriptions" value={catalog.isLoading ? "…" : totals.subscriptions.toLocaleString()} icon={Building2} footer={catalog.data ? (totals.unpinned > 0 ? `${totals.unpinned} legacy (not pinned to a version)` : "All pinned to a published version") : undefined} />
        <MetricCard label="Verified prices" value={catalog.isLoading ? "…" : totals.prices} icon={CreditCard} footer={catalog.data ? `Provider: ${catalog.data.provider.kind}${catalog.data.provider.stripeMode ? ` (${catalog.data.provider.stripeMode})` : ""} · ${catalog.data.provider.available ? "available" : "not configured"}` : undefined} />
        <MetricCard label="Tenants with overrides" value={catalog.isLoading ? "…" : totals.overrides} icon={SlidersHorizontal} footer="Per-tenant limit overrides (managed in Subscriptions)" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan catalog</CardTitle>
          <CardDescription>Default limits of each plan's current published version (or its row while not versioned). They apply to every subscriber unless the tenant carries its own override. Null limits are unlimited.</CardDescription>
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
                    <TableHead>Versions</TableHead>
                    <TableHead>Trial</TableHead>
                    {LIMIT_RESOURCES.map((r) => (
                      <TableHead key={r} className="text-right">{RESOURCE_LABEL[r]}</TableHead>
                    ))}
                    <TableHead className="text-right">Prices</TableHead>
                    <TableHead className="text-right">Subscriptions</TableHead>
                    <TableHead className="text-right">Overrides</TableHead>
                    <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.id} data-testid={`plan-row-${p.id}`} data-status={p.status} data-state={selected === p.id ? "selected" : undefined}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <span data-testid={`plan-status-${p.id}`}><StatusBadge tone={planStatusTone(p.status)}>{PLAN_STATUS_LABEL[p.status] ?? p.status}</StatusBadge></span>
                          {!p.isActive && p.status === "published" && <Badge variant="outline">inactive</Badge>}
                          {p.seeded && <Badge variant="outline">fixed</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs" data-testid={`plan-version-${p.id}`}>
                        <div>{versionCell(p)}</div>
                        {p.unpinnedSubscriptions > 0 && <div className="text-amber-700 dark:text-amber-400">{p.unpinnedSubscriptions} legacy subscriber{p.unpinnedSubscriptions === 1 ? "" : "s"}</div>}
                      </TableCell>
                      <TableCell>{p.trialDays} d</TableCell>
                      {LIMIT_RESOURCES.map((r) => (
                        <TableCell key={r} className="text-right tabular-nums" data-testid={`plan-limit-${p.id}-${r}`}>{limitText(p.limits[r])}</TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums">{p.activePriceCount}{p.prices.length > p.activePriceCount ? <span className="text-muted-foreground"> / {p.prices.length}</span> : null}</TableCell>
                      <TableCell className="text-right tabular-nums" data-testid={`plan-subs-${p.id}`}>{p.subscriptions.total.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.subscriptions.withOverrides.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant={selected === p.id ? "default" : "outline"} size="sm" onClick={() => pick(p.id)} data-testid={`plan-details-${p.id}`}>Details</Button>
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
              Published plan versions are immutable and shared by every subscriber pinned to them. To change a plan, create a draft, validate it and publish it as a new version — existing subscribers are never moved automatically. The five fixed plans (free, starter, professional, business, enterprise) are permanent. Per-tenant limit overrides are managed from <Link href="/platform/subscriptions" className="underline underline-offset-2">Subscriptions</Link>.
            </span>
          </p>
        </CardContent>
      </Card>

      {catalog.data && (
        <Card data-testid="trial-policy-card">
          <CardHeader>
            <CardTitle>Trial policy</CardTitle>
            <CardDescription>How trials behave today for every plan (platform-wide). Each published version also carries its own trial policy (length, eligibility, end-of-trial outcome) — displayed in the version workspace and enforced from PB-3.</CardDescription>
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
                <CardDescription>{detail.data?.description ?? "Plan details, limits, features, verified prices, subscription counts and versions."}</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => { setDupForm({ id: "", name: "" }); setDupOpen(true); }} disabled={!detail.data} data-testid="plan-duplicate-open">
                  <Copy className="mr-1 h-4 w-4" aria-hidden="true" />
                  Duplicate
                </Button>
                <Button variant="outline" size="sm" onClick={() => setArchiveOpen(true)} disabled={!detail.data || detail.data.status !== "published" || detail.data.seeded} data-testid="plan-archive-open">
                  <Archive className="mr-1 h-4 w-4" aria-hidden="true" />
                  Archive
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)} data-testid="plan-detail-close">Close</Button>
              </div>
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
                  <span data-testid="plan-detail-status"><StatusBadge tone={planStatusTone(detail.data.status)}>{PLAN_STATUS_LABEL[detail.data.status] ?? detail.data.status}</StatusBadge></span>
                  <StatusBadge tone={detail.data.isActive ? "success" : "neutral"}>{detail.data.isActive ? "Active" : "Inactive"}</StatusBadge>
                  {detail.data.seeded && <Badge variant="outline">fixed catalog plan</Badge>}
                  <Badge variant="secondary" data-testid="plan-detail-version">
                    {detail.data.currentVersion ? `current ${versionLabel(detail.data.currentVersion)}` : "not versioned"}
                    {detail.data.draft ? ` · draft ${versionLabel(detail.data.draft)} (${stateLabel(detail.data.draft)})` : ""}
                  </Badge>
                  <span className="text-muted-foreground">Sort order {detail.data.sortOrder} · Trial {detail.data.trialDays} days · Updated {fmt(detail.data.updatedAt)}</span>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Default limits (current version)</h3>
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
                    <p className="mt-2 text-xs text-muted-foreground">Effective limit = tenant override ?? pinned version default (or plan row while unversioned) ?? unlimited (single resolver). {detail.data.overrides.tenantsWithAnyOverride} tenant{detail.data.overrides.tenantsWithAnyOverride === 1 ? "" : "s"} on this plan carry at least one override.</p>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <h3 className="mb-2 text-sm font-semibold">Features (current version)</h3>
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
                        <div className="rounded-md border p-2"><div className="text-muted-foreground">Pinned / legacy</div><div className="font-medium tabular-nums" data-testid="plan-count-pinned">{detail.data.pinnedSubscriptions} / {detail.data.unpinnedSubscriptions}</div></div>
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

                <div className="border-t pt-6">
                  <PlanVersions
                    planId={selected}
                    onPlanDeleted={() => {
                      setSelected(null);
                      setPreviewPlan("");
                    }}
                  />
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card data-testid="preview-card">
        <CardHeader>
          <CardTitle>Effective-limit preview</CardTitle>
          <CardDescription>What a tenant's effective limits would be under a plan version, computed by the same resolver and usage counter the product enforces with. Nothing is changed by previewing.</CardDescription>
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
            <Select value={previewVersion} onValueChange={setPreviewVersion} disabled={!previewPlan || (previewVersions.data?.versions.length ?? 0) === 0}>
              <SelectTrigger className="sm:w-[220px]" data-testid="preview-version"><SelectValue placeholder="Version" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current published version</SelectItem>
                {(previewVersions.data?.versions ?? []).map((v) => (
                  <SelectItem key={v.id} value={String(v.id)}>{versionLabel(v)} · {stateLabel(v)}</SelectItem>
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
            <p className="text-sm text-muted-foreground" data-testid="preview-empty">Pick a tenant to preview its effective limits under the selected plan version.</p>
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
                <Badge variant="secondary" data-testid="preview-version-label">
                  {preview.data.previewVersion != null ? `v${preview.data.previewVersion} (${preview.data.previewVersionState ?? "published"})` : "plan row (not versioned)"}
                </Badge>
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

      <Dialog open={createOpen} onOpenChange={(o) => !busy && setCreateOpen(o)}>
        <DialogContent data-testid="plan-create-dialog">
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>Creates a draft plan with an empty first version. It becomes assignable only after you validate and publish that version. The five fixed ids are reserved.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="plan-create-id">Plan id (slug)</Label>
              <Input id="plan-create-id" value={createForm.id} onChange={(e) => setCreateForm({ ...createForm, id: e.target.value.toLowerCase() })} placeholder="growth" maxLength={40} autoFocus data-testid="plan-create-id" />
              {createForm.id && !createIdOk && <p className="text-xs text-destructive">2–40 characters: lowercase letters, digits and dashes, starting with a letter.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-create-name">Display name</Label>
              <Input id="plan-create-name" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} maxLength={80} data-testid="plan-create-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-create-desc">Description (optional)</Label>
              <Textarea id="plan-create-desc" value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} maxLength={500} rows={2} data-testid="plan-create-description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitCreate()} disabled={busy || !createIdOk || !createForm.name.trim()} data-testid="plan-create-submit">{busy ? "Creating…" : "Create draft plan"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dupOpen} onOpenChange={(o) => !busy && setDupOpen(o)}>
        <DialogContent data-testid="plan-duplicate-dialog">
          <DialogHeader>
            <DialogTitle>Duplicate {selected}</DialogTitle>
            <DialogDescription>Copies the current published version's limits, features, trial policy and display fields into a new draft plan. Provider prices are never copied (a price belongs to exactly one plan).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="plan-dup-id">New plan id (slug)</Label>
              <Input id="plan-dup-id" value={dupForm.id} onChange={(e) => setDupForm({ ...dupForm, id: e.target.value.toLowerCase() })} maxLength={40} autoFocus data-testid="plan-duplicate-id" />
              {dupForm.id && !dupIdOk && <p className="text-xs text-destructive">2–40 characters: lowercase letters, digits and dashes, starting with a letter.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-dup-name">Display name (optional)</Label>
              <Input id="plan-dup-name" value={dupForm.name} onChange={(e) => setDupForm({ ...dupForm, name: e.target.value })} maxLength={80} placeholder={`${detail.data?.name ?? selected} (copy)`} data-testid="plan-duplicate-name" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitDuplicate()} disabled={busy || !dupIdOk} data-testid="plan-duplicate-submit">{busy ? "Duplicating…" : "Create copy"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveOpen} onOpenChange={(o) => !o && !busy && setArchiveOpen(false)}>
        <AlertDialogContent data-testid="plan-archive-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {selected}?</AlertDialogTitle>
            <AlertDialogDescription>
              An archived plan can no longer be assigned or drafted. Archiving is allowed only for a published, non-fixed plan with no subscribers and no open draft; the five fixed plans require a migration target (PB-4). Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail.data && (
            <p className="text-sm" data-testid="plan-archive-impact">
              Subscribers: <span className="font-medium tabular-nums">{detail.data.subscriptions.total}</span> · versions: <span className="font-medium tabular-nums">{detail.data.versionCount}</span>
              {detail.data.draft ? " · an open draft blocks archiving" : ""}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void submitArchive(); }} disabled={busy || !detail.data || detail.data.subscriptions.total > 0 || !!detail.data.draft} data-testid="plan-archive-confirm">
              {busy ? "Archiving…" : "Archive plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
