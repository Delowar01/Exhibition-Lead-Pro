import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  usePlatformListPlanVersions,
  usePlatformGetPlanVersion,
  usePlatformCreatePlanDraft,
  usePlatformUpdatePlanDraft,
  usePlatformDeletePlanDraft,
  usePlatformValidatePlanVersion,
  usePlatformPublishPlanVersion,
  usePlatformRetirePlanVersion,
  usePlatformPlanVersionImpact,
  usePlatformComparePlanVersions,
  getPlatformListPlanVersionsQueryKey,
  getPlatformGetPlanVersionQueryKey,
  getPlatformPlanVersionImpactQueryKey,
  getPlatformComparePlanVersionsQueryKey,
  ApiError,
  type PlatformPlanVersion,
  type PlatformPlanVersionDetail,
  type PlatformPlanVersionValidation,
  type PlatformUpdateDraftInput,
  type PlatformFieldIssue,
  type PlatformCompareRow,
  type PlatformPlanVersionImpact,
  type PlatformVersionPriceMapping,
  type PlatformPlanManualPrice,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { StatusBadge, TableSkeleton, ErrorState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { LIMIT_RESOURCES, STATUS_LABEL, fmtDateTime, errMessage } from "@/components/platform/SubscriptionManager";
import { Lock, GitBranch, ShieldCheck, AlertTriangle, Users } from "lucide-react";
import { MigrateTenantsDialog } from "@/components/platform/MigrateTenantsDialog";

// Batch 40 — Plan Builder PB-2: the platform owner's version workspace for ONE plan.
//
// A plan changes only through versions: a draft is edited, validated and then
// published ATOMICALLY as an immutable version; subscribers stay pinned to the
// version they were assigned (grandfathering — publishing never moves anyone),
// new assignments take the newest published version, and a published version
// can be retired (kept for its subscribers, no longer assigned). Every control
// here maps 1:1 to a platform_owner-only API action that is itself guarded and
// audited server-side; the UI never decides policy.
//
// Batch 41 (PB-3): a version's feature matrix is ENFORCED for its pinned tenants
// only when its enforcement mode is `enforced`; `legacy` versions (every
// version published before PB-3, and any version that keeps the mode) are
// grandfathered — every catalog feature stays allowed whatever the recorded
// flags say. AI/OCR allowances seed the Enterprise AI Layer budget (a tenant's
// own non-null budget wins), and the trial end-of-trial policy may configure a
// 1–90 day read-only grace instead of the default immediate block.
//
// Batch 42 (PB-4): a draft carries platform-managed price summaries (manual
// billing; recorded in the immutable snapshot, never billed by the product) and
// shows the provider price mappings that apply to it (plan-wide or bound to the
// version) with their verification state; publication refuses unverified or
// mode-mismatched mappings. A published version offers "Migrate tenants…" — the
// dry-run → review → confirm → execute flow of MigrateTenantsDialog.

type Resource = (typeof LIMIT_RESOURCES)[number];
const RESOURCE_LABEL: Record<Resource, string> = { contacts: "Contacts", events: "Events", admins: "Admins", employees: "Employees", scans: "Scans", storageMb: "Storage (MB)" };
const FEATURE_LABEL: Record<string, string> = {
  "ai.assistant": "AI Assistant",
  "ai.command_center": "AI Command Center",
  "workflow.intelligence": "Workflow Intelligence",
  "executive.intelligence": "Executive Intelligence",
  "exports.scheduled": "Scheduled exports",
  "nfc.capture": "NFC capture",
  documents: "Documents",
  "api.access": "API access",
};

export function limitText(n: number | null | undefined): string {
  return n == null ? "Unlimited" : n.toLocaleString();
}
export function versionLabel(v: { version: number }): string {
  return `v${v.version}`;
}
export function stateLabel(v: { state: string; isCurrent?: boolean }): string {
  if (v.state === "draft") return "Draft";
  if (v.state === "retired") return "Retired";
  return v.isCurrent ? "Published · current" : "Published";
}
export function stateTone(state: string): "success" | "warning" | "neutral" | "info" {
  return state === "published" ? "success" : state === "draft" ? "warning" : "neutral";
}
function compareValue(group: string, v: unknown, field?: string): string {
  if (v == null) return group === "limits" ? "Unlimited" : group === "allowances" ? "None" : "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (group === "enforcement") return ENFORCEMENT_LABEL[String(v)] ?? String(v);
  if (group === "allowances" && field === "aiCostMicroUsdPerMonth" && typeof v === "number") return microToUsdText(v);
  return String(v);
}
function issueText(i: PlatformFieldIssue): string {
  return `${i.field}: ${i.message} (${i.code})`;
}
function detailIssues(err: unknown): PlatformFieldIssue[] {
  if (err instanceof ApiError) {
    // The API emits AppError details under `context`; `details` is reserved for the generic
    // array-of-field-issues contract of request-validation failures (errorHandler.ts).
    const d = err.data as { context?: { issues?: PlatformFieldIssue[] } } | null;
    return Array.isArray(d?.context?.issues) ? d!.context!.issues! : [];
  }
  return [];
}

/** Every Plan Builder query lives under /api/platform/plans — one predicate refreshes them all after a mutation. */
export function invalidatePlanQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/platform/plans") });
}

type TrialForm = { trialDays: string; eligible: boolean; oncePerCompany: boolean; endOutcome: "blocked" | "read_only"; readOnlyGraceDays: string };
type Enforcement = "legacy" | "enforced";
type AllowanceForm = { aiTokensPerMonth: string; aiCostUsdPerMonth: string };
type ManualPriceForm = { interval: "day" | "week" | "month" | "year"; intervalCount: string; currency: string; unitAmount: string; label: string };
type DraftForm = { name: string; description: string; sortOrder: string; limits: Record<Resource, string>; features: Record<string, boolean>; featureEnforcement: Enforcement; allowances: AllowanceForm; trial: TrialForm; manualPrices: ManualPriceForm[] };

export const INTERVAL_LABEL: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
export function periodText(interval: string, intervalCount: number): string {
  return intervalCount > 1 ? `every ${intervalCount} ${INTERVAL_LABEL[interval] ?? interval}s` : `per ${INTERVAL_LABEL[interval] ?? interval}`;
}
/** Monthly / annual / other grouping used by the pricing views. */
export function periodGroup(interval: string, intervalCount: number): "monthly" | "annual" | "other" {
  if (interval === "month" && intervalCount === 1) return "monthly";
  if ((interval === "year" && intervalCount === 1) || (interval === "month" && intervalCount === 12)) return "annual";
  return "other";
}
export function moneyText(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export const ENFORCEMENT_LABEL: Record<string, string> = { legacy: "Legacy (grandfathered)", enforced: "Enforced", invalid: "Invalid reference" };
export function enforcementTone(mode: string): "success" | "warning" | "neutral" | "info" {
  return mode === "enforced" ? "info" : mode === "invalid" ? "warning" : "neutral";
}
export function microToUsdText(micro: number | null | undefined): string {
  return micro == null ? "None" : `$${(micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
export function tokensText(n: number | null | undefined): string {
  return n == null ? "None" : n.toLocaleString();
}

function formFrom(v: PlatformPlanVersionDetail): DraftForm {
  const limits = {} as Record<Resource, string>;
  for (const r of LIMIT_RESOURCES) {
    const n = v.snapshot.limits[r];
    limits[r] = n == null ? "" : String(n);
  }
  return {
    name: v.snapshot.name,
    description: v.snapshot.description ?? "",
    sortOrder: String(v.snapshot.sortOrder),
    limits,
    features: { ...v.snapshot.features },
    manualPrices: (v.snapshot.manualPrices ?? []).map((p) => ({ interval: p.interval, intervalCount: String(p.intervalCount), currency: p.currency, unitAmount: (p.unitAmountMinor / 100).toFixed(2), label: p.label ?? "" })),
    featureEnforcement: v.featureEnforcement,
    allowances: {
      aiTokensPerMonth: v.allowances.aiTokensPerMonth == null ? "" : String(v.allowances.aiTokensPerMonth),
      aiCostUsdPerMonth: v.allowances.aiCostMicroUsdPerMonth == null ? "" : String(v.allowances.aiCostMicroUsdPerMonth / 1_000_000),
    },
    trial: {
      trialDays: String(v.trialPolicy.trialDays),
      eligible: v.trialPolicy.eligible,
      oncePerCompany: v.trialPolicy.oncePerCompany,
      endOutcome: v.trialPolicy.endOutcome,
      readOnlyGraceDays: String(v.trialPolicy.readOnlyGraceDays),
    },
  };
}
function num(s: string): number {
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : NaN;
}
function bodyFrom(f: DraftForm): PlatformUpdateDraftInput {
  const limits: Record<string, number | null> = {};
  for (const r of LIMIT_RESOURCES) limits[r] = f.limits[r].trim() === "" ? null : num(f.limits[r]);
  return {
    name: f.name.trim(),
    description: f.description.trim() === "" ? null : f.description.trim(),
    sortOrder: num(f.sortOrder),
    limits,
    features: { ...f.features },
    featureEnforcement: f.featureEnforcement,
    allowances: {
      aiTokensPerMonth: f.allowances.aiTokensPerMonth.trim() === "" ? null : num(f.allowances.aiTokensPerMonth),
      aiCostMicroUsdPerMonth: f.allowances.aiCostUsdPerMonth.trim() === "" ? null : Math.round(num(f.allowances.aiCostUsdPerMonth) * 1_000_000),
    },
    trialPolicy: {
      trialDays: num(f.trial.trialDays),
      eligible: f.trial.eligible,
      oncePerCompany: f.trial.oncePerCompany,
      endOutcome: f.trial.endOutcome,
      readOnlyGraceDays: num(f.trial.readOnlyGraceDays),
    },
    manualPrices: f.manualPrices.map((p) => ({
      interval: p.interval,
      intervalCount: num(p.intervalCount),
      currency: p.currency.trim().toLowerCase(),
      unitAmountMinor: Math.round(num(p.unitAmount) * 100),
      label: p.label.trim() === "" ? null : p.label.trim(),
    })),
  };
}
const EMPTY_MANUAL_PRICE: ManualPriceForm = { interval: "month", intervalCount: "1", currency: "usd", unitAmount: "0.00", label: "" };

export interface PlanVersionsProps {
  planId: string;
  /** Lets the page react (e.g. re-select) after a lifecycle action. */
  onChanged?: () => void;
  /** Deleting the only draft of a never-published plan removes the plan itself; the page must drop its selection. */
  onPlanDeleted?: () => void;
}

export function PlanVersions({ planId, onChanged, onPlanDeleted }: PlanVersionsProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const list = usePlatformListPlanVersions(planId, { query: { queryKey: getPlatformListPlanVersionsQueryKey(planId) } });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [form, setForm] = useState<DraftForm | null>(null);
  const [formKey, setFormKey] = useState<string>("");
  const [saveIssues, setSaveIssues] = useState<PlatformFieldIssue[]>([]);
  const [validation, setValidation] = useState<PlatformPlanVersionValidation | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const versions: PlatformPlanVersion[] = list.data?.versions ?? [];
  // Default selection: the draft (the thing to work on) else the current published version.
  // Never re-select from a list that is being refreshed: a just-created draft is selected before
  // the stale list contains it, and a stale list must not snap the selection back.
  useEffect(() => {
    if (!list.data || list.isFetching) return;
    if (selectedId && versions.some((v) => v.id === selectedId)) return;
    setSelectedId(list.data.draftVersionId ?? list.data.currentVersionId ?? versions[0]?.id ?? null);
  }, [list.data, list.isFetching, selectedId, versions]);
  useEffect(() => {
    setCompareWith(null);
    setValidation(null);
    setSaveIssues([]);
  }, [selectedId]);

  const detail = usePlatformGetPlanVersion(planId, selectedId ?? 0, { query: { enabled: !!selectedId, queryKey: getPlatformGetPlanVersionQueryKey(planId, selectedId ?? 0) } });
  const impact = usePlatformPlanVersionImpact(planId, selectedId ?? 0, { query: { enabled: !!selectedId, queryKey: getPlatformPlanVersionImpactQueryKey(planId, selectedId ?? 0) } });
  const comparison = usePlatformComparePlanVersions(planId, selectedId ?? 0, compareWith ?? 0, {
    query: { enabled: !!selectedId && !!compareWith, queryKey: getPlatformComparePlanVersionsQueryKey(planId, selectedId ?? 0, compareWith ?? 0) },
  });

  // (Re)seed the editor whenever a different draft (or a newer save of it) arrives.
  useEffect(() => {
    const v = detail.data;
    if (!v) return;
    const key = `${v.id}:${v.updatedAt}`;
    if (key === formKey) return;
    setFormKey(key);
    setForm(v.state === "draft" ? formFrom(v) : null);
    if (v.state === "draft") setValidation(v.validation ?? null);
  }, [detail.data, formKey]);

  const m = {
    createDraft: usePlatformCreatePlanDraft(),
    update: usePlatformUpdatePlanDraft(),
    remove: usePlatformDeletePlanDraft(),
    validate: usePlatformValidatePlanVersion(),
    publish: usePlatformPublishPlanVersion(),
    retire: usePlatformRetirePlanVersion(),
  };

  // Awaited by every mutation so the version list is fresh before the selection moves.
  const refresh = async () => {
    await invalidatePlanQueries(queryClient);
    onChanged?.();
  };
  const fail = (title: string, err: unknown) => toast({ title, description: errMessage(err), variant: "destructive" });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const newDraft = (sourceVersionId?: number) =>
    run(async () => {
      try {
        const v = await m.createDraft.mutateAsync({ planId, data: sourceVersionId ? { sourceVersionId } : {} });
        toast({ title: `Draft ${versionLabel(v)} created` });
        await refresh();
        setSelectedId(v.id);
      } catch (err) {
        fail("Draft not created", err);
      }
    });

  const save = () =>
    run(async () => {
      if (!form || !selectedId) return;
      setSaveIssues([]);
      try {
        const v = await m.update.mutateAsync({ planId, versionId: selectedId, data: bodyFrom(form) });
        toast({ title: `Draft ${versionLabel(v)} saved` });
        setValidation(null);
        await refresh();
      } catch (err) {
        setSaveIssues(detailIssues(err));
        fail("Draft not saved", err);
      }
    });

  const validate = () =>
    run(async () => {
      if (!selectedId) return;
      try {
        const r = await m.validate.mutateAsync({ planId, versionId: selectedId });
        setValidation(r);
        toast({ title: r.publishable ? "Version is publishable" : r.ok ? "Valid, but blocked from publication" : "Version has validation errors" });
      } catch (err) {
        fail("Validation failed", err);
      }
    });

  const openPublish = () =>
    run(async () => {
      if (!selectedId) return;
      try {
        const r = await m.validate.mutateAsync({ planId, versionId: selectedId });
        setValidation(r);
        void impact.refetch();
        setPublishOpen(true);
      } catch (err) {
        fail("Validation failed", err);
      }
    });

  const publish = () =>
    run(async () => {
      if (!selectedId) return;
      try {
        const v = await m.publish.mutateAsync({ planId, versionId: selectedId });
        toast({ title: `${versionLabel(v)} published`, description: "Existing subscribers stay on their pinned versions; new assignments take this version." });
        setPublishOpen(false);
        await refresh();
      } catch (err) {
        fail("Not published", err);
      }
    });

  const retire = () =>
    run(async () => {
      if (!selectedId) return;
      try {
        const v = await m.retire.mutateAsync({ planId, versionId: selectedId });
        toast({ title: `${versionLabel(v)} retired`, description: "Its subscribers keep their entitlements; it is no longer assigned." });
        setRetireOpen(false);
        await refresh();
      } catch (err) {
        fail("Not retired", err);
      }
    });

  const remove = () =>
    run(async () => {
      if (!selectedId) return;
      try {
        const r = await m.remove.mutateAsync({ planId, versionId: selectedId });
        toast({ title: r.planDeleted ? "Draft plan deleted" : "Draft deleted" });
        setDeleteOpen(false);
        if (r.planDeleted) onPlanDeleted?.();
        await refresh();
        setSelectedId(null);
      } catch (err) {
        fail("Not deleted", err);
      }
    });

  const v = detail.data ?? null;
  const isDraft = v?.state === "draft";
  const hasDraft = !!list.data?.draftVersionId;
  const archived = list.data?.planStatus === "archived";
  const otherVersions = useMemo(() => versions.filter((x) => x.id !== selectedId), [versions, selectedId]);
  const changedRows = useMemo(() => (impact.data?.publish?.diffVsCurrent ?? []).filter((r) => r.changed), [impact.data]);

  return (
    <div className="space-y-6" data-testid="plan-versions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-semibold">Version history</span>
          {list.data && (
            <>
              <Badge variant="secondary" data-testid="versions-count">{versions.length} version{versions.length === 1 ? "" : "s"}</Badge>
              {list.data.unpinnedSubscribers > 0 && (
                <span data-testid="versions-unpinned"><StatusBadge tone="warning">{list.data.unpinnedSubscribers} legacy subscriber{list.data.unpinnedSubscribers === 1 ? "" : "s"} not pinned</StatusBadge></span>
              )}
            </>
          )}
        </div>
        <Button size="sm" onClick={() => void newDraft()} disabled={busy || hasDraft || archived || list.isLoading} data-testid="version-new-draft">
          New draft
        </Button>
      </div>

      {list.isLoading ? (
        <TableSkeleton rows={3} />
      ) : list.isError ? (
        <ErrorState title="Versions could not be loaded" description={errMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => void list.refetch()}>Retry</Button>} />
      ) : versions.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="versions-empty">
          This plan is not versioned yet: its row is the only source of entitlements. Create a draft to start versioning (publication requires every legacy subscriber to be pinned by the version-1 backfill first).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid="version-table">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Entitlements</TableHead>
                <TableHead>Published</TableHead>
                <TableHead>Retired</TableHead>
                <TableHead className="text-right">Subscribers</TableHead>
                <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((x) => (
                <TableRow key={x.id} data-testid={`version-row-${x.id}`} data-version={x.version} data-state={selectedId === x.id ? "selected" : undefined}>
                  <TableCell className="font-medium">{versionLabel(x)}</TableCell>
                  <TableCell><span data-testid={`version-state-${x.id}`}><StatusBadge tone={stateTone(x.state)}>{stateLabel(x)}</StatusBadge></span></TableCell>
                  <TableCell><span data-testid={`version-enforcement-${x.id}`}><StatusBadge tone={enforcementTone(x.featureEnforcement)}>{ENFORCEMENT_LABEL[x.featureEnforcement] ?? x.featureEnforcement}</StatusBadge></span></TableCell>
                  <TableCell>{fmtDateTime(x.publishedAt)}</TableCell>
                  <TableCell>{fmtDateTime(x.retiredAt)}</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid={`version-subs-${x.id}`}>{x.subscribers}</TableCell>
                  <TableCell className="text-right">
                    <Button variant={selectedId === x.id ? "default" : "outline"} size="sm" onClick={() => setSelectedId(x.id)} data-testid={`version-open-${x.id}`}>
                      {x.state === "draft" ? "Edit" : "Open"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selectedId && (
        <div className="rounded-lg border p-4" data-testid="version-panel">
          {detail.isLoading ? (
            <TableSkeleton rows={6} />
          ) : detail.isError ? (
            <ErrorState title="Version could not be loaded" description={errMessage(detail.error)} action={<Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Retry</Button>} />
          ) : v ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-base font-semibold" data-testid="version-title">{versionLabel(v)} · {v.snapshot.name}</span>
                  <span data-testid="version-state"><StatusBadge tone={stateTone(v.state)}>{stateLabel(v)}</StatusBadge></span>
                  <span data-testid="version-enforcement"><StatusBadge tone={enforcementTone(v.featureEnforcement)}>{ENFORCEMENT_LABEL[v.featureEnforcement] ?? v.featureEnforcement}</StatusBadge></span>
                  <Badge variant="outline">{v.subscribers} subscriber{v.subscribers === 1 ? "" : "s"}</Badge>
                  {v.publishedAt && <span className="text-muted-foreground">Published {fmtDateTime(v.publishedAt)}</span>}
                  {v.retiredAt && <span className="text-muted-foreground">Retired {fmtDateTime(v.retiredAt)}</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {isDraft ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => void validate()} disabled={busy} data-testid="version-validate">Validate</Button>
                      <Button variant="outline" size="sm" onClick={() => void save()} disabled={busy || !form} data-testid="version-save">Save draft</Button>
                      <Button size="sm" onClick={() => void openPublish()} disabled={busy} data-testid="version-publish-open">Publish…</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(true)} disabled={busy} data-testid="version-delete-open">Delete draft</Button>
                    </>
                  ) : (
                    <>
                      {v.state === "published" && (
                        <Button variant="outline" size="sm" onClick={() => void newDraft(v.id)} disabled={busy || hasDraft || archived} data-testid="version-draft-from">New draft from this version</Button>
                      )}
                      {v.state === "published" && (
                        <Button variant="outline" size="sm" onClick={() => setMigrateOpen(true)} disabled={busy} data-testid="version-migrate-open"><Users className="mr-1 h-3 w-3" aria-hidden="true" />Migrate tenants…</Button>
                      )}
                      {v.state === "published" && (
                        <Button variant="outline" size="sm" onClick={() => { void impact.refetch(); setRetireOpen(true); }} disabled={busy} data-testid="version-retire-open">Retire…</Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {!isDraft && (
                <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="version-immutable-notice">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {v.state === "retired" ? "Retired versions" : "Published versions"} are immutable: the API rejects edits (409 VERSION_IMMUTABLE) and every subscriber pinned to this version keeps exactly these entitlements. To change the plan, create a new draft from this version and publish it — publishing never moves existing subscribers.
                  </span>
                </p>
              )}

              {isDraft && form ? (
                <div className="grid gap-6 lg:grid-cols-2" data-testid="version-editor">
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="pv-name">Display name</Label>
                        <Input id="pv-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} data-testid="version-name" />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="pv-desc">Description</Label>
                        <Textarea id="pv-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} rows={2} data-testid="version-description" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="pv-sort">Sort order</Label>
                        <Input id="pv-sort" type="number" min={0} max={1000} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} data-testid="version-sort-order" />
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Limits</h4>
                      <p className="mb-2 text-xs text-muted-foreground">Blank = unlimited. Admins must allow at least one. Storage is informational today (not enforced by the resolver).</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {LIMIT_RESOURCES.map((r) => (
                          <div key={r} className="space-y-1.5">
                            <Label htmlFor={`pv-limit-${r}`}>{RESOURCE_LABEL[r]}</Label>
                            <Input
                              id={`pv-limit-${r}`}
                              type="number"
                              min={0}
                              inputMode="numeric"
                              placeholder="Unlimited"
                              value={form.limits[r]}
                              onChange={(e) => setForm({ ...form, limits: { ...form.limits, [r]: e.target.value } })}
                              data-testid={`version-limit-${r}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Feature entitlements</h4>
                      <div className="mb-3 space-y-1.5">
                        <Label>Enforcement for tenants pinned to this version</Label>
                        <Select value={form.featureEnforcement} onValueChange={(val) => setForm({ ...form, featureEnforcement: val as Enforcement })}>
                          <SelectTrigger data-testid="version-enforcement-select"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="legacy">Legacy — grandfathered: every feature stays allowed, flags are recorded only</SelectItem>
                            <SelectItem value="enforced">Enforced — tenants get exactly the features switched on below</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground" data-testid="version-enforcement-note">
                          {form.featureEnforcement === "enforced"
                            ? "Enforced: once published, a tenant assigned to this version is refused every feature switched off here (API 403 FEATURE_NOT_ENTITLED; hidden in the web and mobile apps). Tenants pinned to other versions are never affected."
                            : "Legacy: the flags below are recorded for information only. Every tenant on this version keeps access to every feature (grandfathered) — identical to versions published before PB-3."}
                        </p>
                      </div>
                      <ul className="grid gap-2 sm:grid-cols-2" data-testid="version-features">
                        {Object.keys(form.features).map((k) => (
                          <li key={k} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                            <span>
                              {FEATURE_LABEL[k] ?? k}
                              {form.featureEnforcement === "legacy" && !form.features[k] && <span className="ml-1 text-xs text-muted-foreground">(allowed — grandfathered)</span>}
                            </span>
                            <Switch checked={form.features[k]} onCheckedChange={(on) => setForm({ ...form, features: { ...form.features, [k]: on } })} aria-label={FEATURE_LABEL[k] ?? k} data-testid={`version-feature-${k}`} />
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4 className="mb-2 text-sm font-semibold">AI / OCR allowances</h4>
                      <p className="mb-2 text-xs text-muted-foreground">Monthly AI budget seeded into the Enterprise AI Layer for tenants on this version. Blank = no plan allowance (unlimited unless the tenant has its own budget). A tenant's own AI budget override always takes precedence.</p>
                      <div className="grid gap-3 sm:grid-cols-2" data-testid="version-allowances">
                        <div className="space-y-1.5">
                          <Label htmlFor="pv-allow-tokens">AI tokens / month</Label>
                          <Input id="pv-allow-tokens" type="number" min={0} inputMode="numeric" placeholder="No allowance" value={form.allowances.aiTokensPerMonth} onChange={(e) => setForm({ ...form, allowances: { ...form.allowances, aiTokensPerMonth: e.target.value } })} data-testid="version-allowance-tokens" />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="pv-allow-cost">AI cost / month (USD)</Label>
                          <Input id="pv-allow-cost" type="number" min={0} step="0.000001" inputMode="decimal" placeholder="No allowance" value={form.allowances.aiCostUsdPerMonth} onChange={(e) => setForm({ ...form, allowances: { ...form.allowances, aiCostUsdPerMonth: e.target.value } })} data-testid="version-allowance-cost" />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="mb-2 text-sm font-semibold">Trial policy</h4>
                      <div className="grid gap-3 sm:grid-cols-2" data-testid="version-trial">
                        <div className="space-y-1.5">
                          <Label htmlFor="pv-trial-days">Trial length (days)</Label>
                          <Input id="pv-trial-days" type="number" min={0} max={365} value={form.trial.trialDays} onChange={(e) => setForm({ ...form, trial: { ...form.trial, trialDays: e.target.value } })} data-testid="version-trial-days" />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="pv-trial-grace">Read-only grace (days)</Label>
                          <Input id="pv-trial-grace" type="number" min={0} max={90} value={form.trial.readOnlyGraceDays} onChange={(e) => setForm({ ...form, trial: { ...form.trial, readOnlyGraceDays: e.target.value } })} data-testid="version-trial-grace" />
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                          <span>Trial eligible</span>
                          <Switch checked={form.trial.eligible} onCheckedChange={(on) => setForm({ ...form, trial: { ...form.trial, eligible: on } })} aria-label="Trial eligible" data-testid="version-trial-eligible" />
                        </div>
                        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                          <span>Once per company</span>
                          <Switch checked={form.trial.oncePerCompany} onCheckedChange={(on) => setForm({ ...form, trial: { ...form.trial, oncePerCompany: on } })} aria-label="Once per company" data-testid="version-trial-once" />
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label>End of trial</Label>
                          <Select value={form.trial.endOutcome} onValueChange={(val) => setForm({ ...form, trial: { ...form.trial, endOutcome: val as TrialForm["endOutcome"] } })}>
                            <SelectTrigger data-testid="version-trial-outcome"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="blocked">Blocked immediately (platform default)</SelectItem>
                              <SelectItem value="read_only">Read-only grace, then blocked (needs 1–90 grace days)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="lg:col-span-2" data-testid="version-manual-prices">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold">Platform-managed prices (manual billing)</h4>
                      <Button variant="outline" size="sm" onClick={() => setForm({ ...form, manualPrices: [...form.manualPrices, { ...EMPTY_MANUAL_PRICE }] })} disabled={form.manualPrices.length >= 8} data-testid="manual-price-add">Add price</Button>
                    </div>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Display and audit only: recorded in the immutable snapshot when this version is published; the product never bills them. Provider (Stripe) pricing is registered separately as a verified price mapping — see the mappings below. Max 8; one price per currency and period.
                    </p>
                    {form.manualPrices.length === 0 ? (
                      <p className="text-xs text-muted-foreground" data-testid="manual-prices-empty">No platform-managed price recorded.</p>
                    ) : (
                      <div className="space-y-2">
                        {form.manualPrices.map((p, i) => (
                          <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-6" data-testid={`manual-price-${i}`}>
                            <div className="space-y-1">
                              <Label className="text-xs">Interval</Label>
                              <Select value={p.interval} onValueChange={(val) => setForm({ ...form, manualPrices: form.manualPrices.map((x, j) => (j === i ? { ...x, interval: val as ManualPriceForm["interval"] } : x)) })}>
                                <SelectTrigger data-testid={`manual-price-interval-${i}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="month">Month</SelectItem>
                                  <SelectItem value="year">Year</SelectItem>
                                  <SelectItem value="week">Week</SelectItem>
                                  <SelectItem value="day">Day</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Every</Label>
                              <Input type="number" min={1} max={12} value={p.intervalCount} onChange={(e) => setForm({ ...form, manualPrices: form.manualPrices.map((x, j) => (j === i ? { ...x, intervalCount: e.target.value } : x)) })} data-testid={`manual-price-count-${i}`} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Currency</Label>
                              <Input maxLength={3} value={p.currency} onChange={(e) => setForm({ ...form, manualPrices: form.manualPrices.map((x, j) => (j === i ? { ...x, currency: e.target.value.toLowerCase() } : x)) })} data-testid={`manual-price-currency-${i}`} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Amount</Label>
                              <Input type="number" min={0} step="0.01" inputMode="decimal" value={p.unitAmount} onChange={(e) => setForm({ ...form, manualPrices: form.manualPrices.map((x, j) => (j === i ? { ...x, unitAmount: e.target.value } : x)) })} data-testid={`manual-price-amount-${i}`} />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Label</Label>
                              <Input maxLength={60} placeholder="optional" value={p.label} onChange={(e) => setForm({ ...form, manualPrices: form.manualPrices.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} data-testid={`manual-price-label-${i}`} />
                            </div>
                            <div className="flex items-end">
                              <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, manualPrices: form.manualPrices.filter((_, j) => j !== i) })} data-testid={`manual-price-remove-${i}`}>Remove</Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="lg:col-span-2">
                    <PriceMappings mappings={v.priceMappings ?? []} providerMode={null} testId="draft-price-mappings" />
                  </div>

                  {saveIssues.length > 0 && (
                    <ul className="text-sm text-destructive lg:col-span-2" data-testid="version-save-errors">
                      {saveIssues.map((i, idx) => <li key={idx}>{issueText(i)}</li>)}
                    </ul>
                  )}
                </div>
              ) : (
                <VersionSnapshot v={v} />
              )}

              {validation && (
                <div className="rounded-md border p-3 text-sm" data-testid="version-validation" data-publishable={validation.publishable ? "true" : "false"}>
                  <div className="flex flex-wrap items-center gap-2">
                    {validation.publishable ? <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />}
                    <span className="font-medium" data-testid="version-validation-summary">
                      {validation.publishable ? "Publishable" : validation.ok ? "Valid content, publication blocked" : `${validation.errors.length} validation error${validation.errors.length === 1 ? "" : "s"}`}
                    </span>
                    <Badge variant="outline">provider mode {validation.providerMode}</Badge>
                    <Badge variant="outline">{validation.pricesConsidered.length} price{validation.pricesConsidered.length === 1 ? "" : "s"} considered</Badge>
                  </div>
                  {validation.errors.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-destructive" data-testid="version-validation-errors">
                      {validation.errors.map((i, idx) => <li key={idx}>{issueText(i)}</li>)}
                    </ul>
                  )}
                  {validation.blockers.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-amber-700 dark:text-amber-400" data-testid="version-validation-blockers">
                      {validation.blockers.map((b, idx) => <li key={idx}>{b.message} ({b.code}{b.count != null ? ` · ${b.count}` : ""})</li>)}
                    </ul>
                  )}
                  {validation.warnings.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-muted-foreground" data-testid="version-validation-warnings">
                      {validation.warnings.map((i, idx) => <li key={idx}>{issueText(i)}</li>)}
                    </ul>
                  )}
                  {(validation.priceMappings?.length ?? 0) > 0 && (
                    <div className="mt-3" data-testid="validation-price-mappings">
                      <PriceMappings mappings={validation.priceMappings ?? []} providerMode={validation.providerMode} compact testId="validation-mapping-list" />
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-6 lg:grid-cols-2">
                <div data-testid="version-impact">
                  <h4 className="mb-2 text-sm font-semibold">Tenant impact</h4>
                  {impact.isLoading ? (
                    <TableSkeleton rows={3} />
                  ) : impact.isError ? (
                    <p className="text-sm text-destructive">{errMessage(impact.error)}</p>
                  ) : impact.data ? (
                    <ImpactSummary impact={impact.data} changedRows={changedRows} />
                  ) : null}
                </div>

                <div data-testid="version-compare">
                  <h4 className="mb-2 text-sm font-semibold">Compare with another version</h4>
                  {otherVersions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No other version to compare with yet.</p>
                  ) : (
                    <div className="space-y-3">
                      <Select value={compareWith ? String(compareWith) : ""} onValueChange={(val) => setCompareWith(Number(val))}>
                        <SelectTrigger className="sm:w-[280px]" data-testid="compare-select"><SelectValue placeholder="Pick a version" /></SelectTrigger>
                        <SelectContent>
                          {otherVersions.map((x) => (
                            <SelectItem key={x.id} value={String(x.id)}>{versionLabel(x)} · {stateLabel(x)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {compareWith && comparison.isLoading ? (
                        <TableSkeleton rows={4} />
                      ) : compareWith && comparison.isError ? (
                        <p className="text-sm text-destructive">{errMessage(comparison.error)}</p>
                      ) : comparison.data ? (
                        <div className="space-y-2" data-testid="compare-result">
                          <div className="flex flex-wrap gap-2 text-xs">
                            <Badge variant="secondary">{comparison.data.changedFields.length} changed field{comparison.data.changedFields.length === 1 ? "" : "s"}</Badge>
                            {comparison.data.tightenedLimits.length > 0 && <StatusBadge tone="warning">tightens: {comparison.data.tightenedLimits.join(", ")}</StatusBadge>}
                            {comparison.data.loosenedLimits.length > 0 && <StatusBadge tone="success">loosens: {comparison.data.loosenedLimits.join(", ")}</StatusBadge>}
                          </div>
                          <div className="overflow-x-auto">
                            <Table data-testid="compare-table">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Field</TableHead>
                                  <TableHead>{versionLabel(comparison.data.left)}</TableHead>
                                  <TableHead>{versionLabel(comparison.data.right)}</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {comparison.data.rows.map((r: PlatformCompareRow) => (
                                  <TableRow key={`${r.group}.${r.field}`} data-testid={`compare-row-${r.group}-${r.field}`} data-changed={r.changed ? "true" : "false"} className={r.changed ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}>
                                    <TableCell><span className="text-muted-foreground">{r.group} · </span>{r.field}</TableCell>
                                    <TableCell className="tabular-nums">{compareValue(r.group, r.left, r.field)}</TableCell>
                                    <TableCell className={`tabular-nums ${r.changed ? "font-medium" : ""}`}>{compareValue(r.group, r.right, r.field)}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {v && v.state === "published" && (
        <MigrateTenantsDialog open={migrateOpen} onClose={() => { setMigrateOpen(false); void refresh(); }} planId={planId} target={v} versions={versions} />
      )}

      {/* Publish confirmation: validation result + tenant impact, then the atomic server-side publish. */}
      <AlertDialog open={publishOpen} onOpenChange={(o) => !o && !busy && setPublishOpen(false)}>
        <AlertDialogContent data-testid="publish-dialog" className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {v ? versionLabel(v) : "version"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Publication is atomic and makes the version immutable. Existing subscribers are never moved (grandfathering); new assignments and plan changes take this version from now on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            {validation && !validation.publishable && (
              <div className="rounded-md border border-destructive/40 p-3" data-testid="publish-blocked">
                <p className="font-medium text-destructive">Cannot publish yet.</p>
                <ul className="mt-1 list-disc pl-5">
                  {validation.errors.map((i, idx) => <li key={`e${idx}`}>{issueText(i)}</li>)}
                  {validation.blockers.map((b, idx) => <li key={`b${idx}`}>{b.message} ({b.code}{b.count != null ? ` · ${b.count}` : ""})</li>)}
                </ul>
              </div>
            )}
            {impact.data && <ImpactSummary impact={impact.data} changedRows={changedRows} compact />}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void publish(); }} disabled={busy || !validation?.publishable} data-testid="publish-confirm">
              {busy ? "Publishing…" : "Publish version"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Retirement: subscribers keep the version; it stops being assigned. */}
      <AlertDialog open={retireOpen} onOpenChange={(o) => !o && !busy && setRetireOpen(false)}>
        <AlertDialogContent data-testid="retire-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {v ? versionLabel(v) : "version"}?</AlertDialogTitle>
            <AlertDialogDescription>
              A retired version is no longer assigned to new or changing subscriptions, but every tenant pinned to it keeps exactly its entitlements. The plan must keep at least one published version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {impact.data?.retire && (
            <div className="space-y-1 text-sm" data-testid="retire-impact">
              <div>Subscribers kept on this version: <span className="font-medium tabular-nums" data-testid="retire-kept">{impact.data.retire.subscribersKept}</span></div>
              {Object.keys(impact.data.retire.subscribersByStatus).length > 0 && (
                <div className="text-muted-foreground">{Object.entries(impact.data.retire.subscribersByStatus).map(([s, n]) => `${STATUS_LABEL[s] ?? s} ${n}`).join(" · ")}</div>
              )}
              <div>{impact.data.retire.isCurrent ? `This is the current version; after retirement new assignments take ${impact.data.retire.newCurrentVersion ? versionLabel(impact.data.retire.newCurrentVersion) : "no version"}.` : "This is not the current version."}</div>
              {impact.data.retire.isLastPublished && <p className="text-destructive" data-testid="retire-blocked">It is the plan's last published version and cannot be retired (409 LAST_PUBLISHED_VERSION).</p>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void retire(); }} disabled={busy || !!impact.data?.retire?.isLastPublished} data-testid="retire-confirm">
              {busy ? "Retiring…" : "Retire version"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(o) => !o && !busy && setDeleteOpen(false)}>
        <AlertDialogContent data-testid="delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft {v ? versionLabel(v) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only unpublished drafts can be deleted; published versions and versions with subscribers are protected. If this draft is the only version of a never-published plan, the plan itself is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void remove(); }} disabled={busy} data-testid="delete-confirm">
              {busy ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VersionSnapshot({ v }: { v: PlatformPlanVersionDetail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="version-snapshot">
      <div>
        <h4 className="mb-2 text-sm font-semibold">Limits</h4>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead className="text-right">Limit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {LIMIT_RESOURCES.map((r) => (
              <TableRow key={r}>
                <TableCell>{RESOURCE_LABEL[r]}</TableCell>
                <TableCell className="text-right tabular-nums" data-testid={`snapshot-limit-${r}`}>{limitText(v.snapshot.limits[r])}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-2 text-xs text-muted-foreground">{v.snapshot.description || "No description."} · Sort order {v.snapshot.sortOrder}</p>
      </div>
      <div className="space-y-4">
        <div>
          <h4 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            Feature entitlements
            <span data-testid="snapshot-enforcement"><StatusBadge tone={enforcementTone(v.featureEnforcement)}>{ENFORCEMENT_LABEL[v.featureEnforcement] ?? v.featureEnforcement}</StatusBadge></span>
          </h4>
          <p className="mb-2 text-xs text-muted-foreground">
            {v.featureEnforcement === "enforced"
              ? "Enforced for every tenant pinned to this version: features marked off are refused by the API and hidden in the apps."
              : "Legacy (grandfathered): every feature is allowed for tenants on this version; recorded flags are informational."}
          </p>
          <ul className="flex flex-wrap gap-2" data-testid="snapshot-features">
            {Object.entries(v.effectiveFeatures).map(([k, allowed]) => {
              const recorded = v.snapshot.features[k] === true;
              return (
                <li key={k}>
                  <Badge variant={allowed ? "default" : "outline"} data-testid={`snapshot-feature-${k}`} data-allowed={allowed ? "true" : "false"}>
                    {FEATURE_LABEL[k] ?? k}: {allowed ? (recorded ? "allowed" : "allowed (grandfathered)") : "denied"}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">AI / OCR allowances</h4>
          <div className="grid grid-cols-2 gap-2 text-sm" data-testid="snapshot-allowances">
            <div className="rounded-md border p-2"><div className="text-muted-foreground">AI tokens / month</div><div className="font-medium tabular-nums" data-testid="snapshot-allowance-tokens">{tokensText(v.allowances.aiTokensPerMonth)}</div></div>
            <div className="rounded-md border p-2"><div className="text-muted-foreground">AI cost / month</div><div className="font-medium tabular-nums" data-testid="snapshot-allowance-cost">{microToUsdText(v.allowances.aiCostMicroUsdPerMonth)}</div></div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">A tenant's own AI budget override takes precedence over the plan allowance.</p>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">Trial policy</h4>
          <div className="grid grid-cols-2 gap-2 text-sm" data-testid="snapshot-trial">
            <div className="rounded-md border p-2"><div className="text-muted-foreground">Trial length</div><div className="font-medium tabular-nums" data-testid="snapshot-trial-days">{v.trialPolicy.trialDays} days</div></div>
            <div className="rounded-md border p-2"><div className="text-muted-foreground">Eligible</div><div className="font-medium">{v.trialPolicy.eligible ? "Yes" : "No"}{v.trialPolicy.oncePerCompany ? " · once per company" : ""}</div></div>
            <div className="rounded-md border p-2"><div className="text-muted-foreground">End of trial</div><div className="font-medium" data-testid="snapshot-trial-outcome">{v.trialPolicy.endOutcome === "blocked" ? "Blocked immediately" : `Read-only for ${v.trialPolicy.readOnlyGraceDays} day${v.trialPolicy.readOnlyGraceDays === 1 ? "" : "s"}, then blocked`}</div></div>
            <div className="rounded-md border p-2"><div className="text-muted-foreground">Prices captured</div><div className="font-medium tabular-nums">{v.snapshot.prices.length}</div></div>
          </div>
        </div>
        <ManualPrices prices={v.snapshot.manualPrices ?? v.manualPrices ?? []} />
        <div data-testid="snapshot-prices">
          <PriceMappings mappings={v.priceMappings ?? []} providerMode={null} captured={v.snapshot.prices} />
        </div>
      </div>
    </div>
  );
}

/** Platform-managed (manual billing) price summaries of a version, grouped monthly / annual / other. */
function ManualPrices({ prices }: { prices: PlatformPlanManualPrice[] }) {
  const groups: Array<["monthly" | "annual" | "other", string]> = [["monthly", "Monthly"], ["annual", "Annual"], ["other", "Other periods"]];
  return (
    <div data-testid="snapshot-manual-prices" data-count={prices.length}>
      <h4 className="mb-2 text-sm font-semibold">Platform-managed prices (manual billing)</h4>
      {prices.length === 0 ? (
        <p className="text-xs text-muted-foreground">None recorded on this version.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3 text-sm">
          {groups.map(([g, label]) => {
            const rows = prices.filter((p) => periodGroup(p.interval, p.intervalCount) === g);
            if (rows.length === 0) return null;
            return (
              <div key={g} className="rounded-md border p-2" data-testid={`manual-prices-${g}`}>
                <div className="text-muted-foreground">{label}</div>
                <ul>
                  {rows.map((p, i) => (
                    <li key={`${p.currency}-${p.interval}-${p.intervalCount}-${i}`} className="font-medium tabular-nums">
                      {moneyText(p.unitAmountMinor, p.currency)} <span className="font-normal text-muted-foreground">{periodText(p.interval, p.intervalCount)}{p.label ? ` · ${p.label}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">Recorded for display and audit only; the product never bills these. Provider pricing lives in the verified mappings below.</p>
    </div>
  );
}

/** Provider price mappings applying to a version (plan-wide + bound), monthly / annual grouping with verification state. */
function PriceMappings({ mappings, providerMode, compact = false, captured, testId = "snapshot-price-mappings" }: { mappings: PlatformVersionPriceMapping[]; providerMode: string | null; compact?: boolean; captured?: Array<{ id: number }>; testId?: string }) {
  const groupOf = (m: PlatformVersionPriceMapping) => periodGroup(m.interval, m.intervalCount);
  const groupLabel: Record<string, string> = { monthly: "Monthly", annual: "Annual", other: "Other" };
  const capturedIds = new Set((captured ?? []).map((c) => c.id));
  return (
    <div data-testid={testId} data-count={mappings.length}>
      <h4 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        Provider price mappings
        {providerMode && <Badge variant="outline">provider mode {providerMode}</Badge>}
      </h4>
      {mappings.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="price-mappings-empty">No provider price applies to this version (plan-wide or bound). Online checkout for it stays unavailable; register prices from Subscriptions.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Active</TableHead>
                {!compact && <TableHead>Ref</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...mappings]
                .sort((a, b) => groupOf(a).localeCompare(groupOf(b)))
                .map((m) => (
                  <TableRow key={m.id} data-testid={`mapping-row-${m.id}`} data-scope={m.scope} data-verified={m.verified && m.modeMatches ? "true" : "false"}>
                    <TableCell><span className="text-muted-foreground">{groupLabel[groupOf(m)]} · </span>{periodText(m.interval, m.intervalCount)}</TableCell>
                    <TableCell className="tabular-nums">{moneyText(m.unitAmountMinor, m.currency)}</TableCell>
                    <TableCell data-testid={`mapping-scope-${m.id}`}>{m.scope === "version" ? "Bound to this version" : "Plan-wide"}{capturedIds.has(m.id) ? " · captured at publication" : ""}</TableCell>
                    <TableCell><Badge variant={m.providerMode === "live" ? "default" : "secondary"}>{m.providerMode}</Badge></TableCell>
                    <TableCell data-testid={`mapping-verified-${m.id}`}>
                      <StatusBadge tone={!m.verified ? "warning" : !m.modeMatches ? "warning" : "success"}>{!m.verified ? "Unverified" : !m.modeMatches ? "Mode mismatch" : "Verified"}</StatusBadge>
                    </TableCell>
                    <TableCell><StatusBadge tone={m.active ? "success" : "neutral"}>{m.active ? "Active" : "Inactive"}</StatusBadge></TableCell>
                    {!compact && <TableCell className="font-mono text-xs">{m.providerPriceRef ?? "—"}</TableCell>}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">A published version's mappings are immutable: deactivate a price rather than delete it; bind new prices to a new draft.</p>
    </div>
  );
}

function ImpactSummary({ impact, changedRows, compact = false }: { impact: PlatformPlanVersionImpact; changedRows: PlatformCompareRow[]; compact?: boolean }) {
  const pub = impact.publish;
  const exceeding = pub?.tenantsExceedingNewLimits ?? { checked: 0, sampled: false, tenants: [] };
  return (
    <div className="space-y-2 text-sm" data-testid={compact ? "publish-impact" : "impact-summary"}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-md border p-2"><div className="text-muted-foreground">Plan subscribers</div><div className="font-medium tabular-nums" data-testid="impact-plan-subscribers">{impact.planSubscribers}</div></div>
        <div className="rounded-md border p-2"><div className="text-muted-foreground">On this version</div><div className="font-medium tabular-nums" data-testid="impact-on-version">{impact.subscribersOnVersion}</div></div>
        <div className="rounded-md border p-2"><div className="text-muted-foreground">Moved by publishing</div><div className="font-medium tabular-nums" data-testid="impact-moved">{pub?.subscribersMoved ?? 0}</div></div>
      </div>
      {impact.state === "draft" && pub && (
        <>
          <p className="text-muted-foreground">
            {pub.wouldBecomeCurrent ? "Publishing makes this the current version: new tenants and plan changes receive it." : "Publishing does not change the current version."}
            {impact.unpinnedSubscribers > 0 ? ` ${impact.unpinnedSubscribers} legacy subscriber${impact.unpinnedSubscribers === 1 ? "" : "s"} must be pinned (version-1 backfill) before publication is allowed.` : ""}
          </p>
          {changedRows.length > 0 ? (
            <p data-testid="impact-diff">Changes vs the current version: {changedRows.map((r) => `${r.field} ${compareValue(r.group, r.left, r.field)} → ${compareValue(r.group, r.right, r.field)}`).join("; ")}.</p>
          ) : (
            <p className="text-muted-foreground" data-testid="impact-diff">{impact.currentVersion ? "No field differs from the current version." : "First publication of this plan."}</p>
          )}
          {pub.tightenedLimits.length > 0 && <span data-testid="impact-tightened"><StatusBadge tone="warning">tightens {pub.tightenedLimits.join(", ")}</StatusBadge></span>}
          {changedRows.some((r) => r.group === "enforcement" || r.group === "features") && (
            <p className="text-muted-foreground" data-testid="impact-entitlements">
              Feature entitlements change only for tenants assigned to this version after publication; every existing subscriber keeps the entitlements of its pinned version (grandfathered).
            </p>
          )}
          <div data-testid="impact-exceeding">
            {exceeding.tenants.length === 0 ? (
              <p className="text-muted-foreground">No current subscriber's usage exceeds the new limits ({exceeding.checked} checked{exceeding.sampled ? ", sampled" : ""}). Existing subscribers are not affected anyway — they stay pinned.</p>
            ) : (
              <>
                <p className="font-medium">{exceeding.tenants.length} tenant{exceeding.tenants.length === 1 ? "" : "s"} would exceed the new limits if moved to this version later ({exceeding.checked} checked{exceeding.sampled ? ", sampled" : ""}):</p>
                {!compact && (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {exceeding.tenants.map((t) => (
                      <li key={t.companyId} data-testid={`impact-tenant-${t.companyId}`}>{t.companyName ?? `Company #${t.companyId}`} ({STATUS_LABEL[t.status] ?? t.status}): {t.resources.map((r) => `${r.resource} ${r.used}/${r.limit}`).join(", ")}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      )}
      {impact.subscribersByVersion.length > 0 && !compact && (
        <p className="text-muted-foreground" data-testid="impact-by-version">Subscribers by version: {impact.subscribersByVersion.map((s) => `v${s.version} ${s.subscribers}`).join(" · ")}.</p>
      )}
    </div>
  );
}
