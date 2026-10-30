import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePlatformMigratePlanVersionTenants,
  type PlatformPlanVersion,
  type PlatformMigrationResult,
  type PlatformMigrationRow,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { errMessage, invalidateCompanyQueries, planRef } from "@/components/platform/SubscriptionManager";
import { invalidatePlanQueries, versionLabel, stateLabel } from "@/components/platform/PlanVersions";

// Batch 42 (PB-4) — safe tenant migration to a PUBLISHED version.
//
// The flow is strictly dry run → review → confirm → execute, and the server
// enforces it: the dry run returns a digest over everything that was reviewed
// (target, source, confirmation flag, every tenant's current reference, reason,
// blockers and feature losses); execution is refused (409 DRY_RUN_STALE) unless a
// fresh dry run over the CURRENT data yields the same digest. Each eligible
// tenant is then migrated in its own transaction with post-commit verification
// and its own audit row; skipped / failed / rolled-back tenants are reported
// honestly. Provider-managed tenants are never migrated here (D4): they are
// listed with reason PROVIDER_MANAGED. Tenants that would lose features need the
// explicit confirmation (D3) or they are reported, never moved.

const REASON_LABEL: Record<string, string> = {
  ELIGIBLE: "Eligible",
  ALREADY_ON_VERSION: "Already on the target",
  PROVIDER_MANAGED: "Provider-managed (excluded)",
  TRANSITION_NOT_ALLOWED: "Lifecycle state does not allow a plan change",
  NOT_ON_SOURCE_VERSION: "Not on the source version",
  DOWNGRADE_BLOCKED: "Blocked: usage exceeds the target limits",
  FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED: "Would lose features (confirmation required)",
  SUBSCRIPTION_MISSING: "No subscription",
};
const OUTCOME_LABEL: Record<string, string> = { migrated: "Migrated", skipped: "Skipped", failed: "Failed", rolled_back: "Rolled back", not_attempted: "Not attempted" };
function outcomeTone(o: string): "success" | "warning" | "destructive" | "neutral" {
  if (o === "migrated") return "success";
  if (o === "skipped" || o === "not_attempted") return "neutral";
  return "destructive";
}
function parseCompanyIds(raw: string): number[] {
  const ids = raw
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number.parseInt(x, 10));
  return Array.from(new Set(ids.filter((n) => Number.isInteger(n) && n > 0)));
}

export interface MigrateTenantsDialogProps {
  open: boolean;
  onClose: () => void;
  planId: string;
  /** The PUBLISHED target version. */
  target: PlatformPlanVersion;
  /** Every version of the plan (source candidates = published / retired versions other than the target). */
  versions: PlatformPlanVersion[];
}

export function MigrateTenantsDialog({ open, onClose, planId, target, versions }: MigrateTenantsDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const migrate = usePlatformMigratePlanVersionTenants();
  const [scopeMode, setScopeMode] = useState<"source" | "companies">("source");
  const [sourceId, setSourceId] = useState<string>("");
  const [companyIdsRaw, setCompanyIdsRaw] = useState("");
  const [confirmFeatures, setConfirmFeatures] = useState(false);
  const [reason, setReason] = useState("");
  const [dryRun, setDryRun] = useState<PlatformMigrationResult | null>(null);
  const [result, setResult] = useState<PlatformMigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = useMemo(() => versions.filter((v) => v.id !== target.id && v.state !== "draft"), [versions, target.id]);
  const companyIds = useMemo(() => parseCompanyIds(companyIdsRaw), [companyIdsRaw]);
  const scopeReady = scopeMode === "source" ? !!sourceId : companyIds.length > 0;

  const body = (execute: boolean) => ({
    dryRun: !execute,
    ...(scopeMode === "source" && sourceId ? { sourceVersionId: Number(sourceId) } : {}),
    ...(scopeMode === "companies" && companyIds.length ? { companyIds } : {}),
    ...(confirmFeatures ? { confirmFeatureDowngrade: true } : {}),
    ...(reason.trim() ? { reason: reason.trim() } : {}),
    ...(execute && dryRun ? { confirmDigest: dryRun.digest } : {}),
  });

  // Any change of the reviewed inputs invalidates the reviewed dry run.
  const invalidate = () => {
    setDryRun(null);
    setResult(null);
    setError(null);
  };

  const runDry = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await migrate.mutateAsync({ planId, versionId: target.id, data: body(false) });
      setDryRun(r);
    } catch (err) {
      setDryRun(null);
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!dryRun) return;
    setBusy(true);
    setError(null);
    try {
      const r = await migrate.mutateAsync({ planId, versionId: target.id, data: body(true) });
      setResult(r);
      toast({ title: r.complete ? `Migration complete: ${r.summary.migrated} migrated` : `Migration finished with failures: ${r.summary.migrated} migrated, ${r.summary.failed} failed, ${r.summary.rolledBack} rolled back`, variant: r.complete ? "default" : "destructive" });
      await invalidatePlanQueries(queryClient);
      invalidateCompanyQueries(queryClient);
      for (const row of r.rows) invalidateCompanyQueries(queryClient, row.companyId);
    } catch (err) {
      setError(errMessage(err));
      // A stale digest means the data changed since the review: the reviewed dry run is no longer valid.
      if (err instanceof Error && /DRY_RUN_STALE/.test(errMessage(err))) setDryRun(null);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const shown = result ?? dryRun;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="migrate-dialog">
        <DialogHeader>
          <DialogTitle>Migrate tenants to {versionLabel(target)}</DialogTitle>
          <DialogDescription>
            Manual-billing tenants only; provider-managed subscriptions are excluded (their plan follows the provider price). Review the dry run, then execute the exact reviewed set — the server refuses a stale review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select value={scopeMode} onValueChange={(v) => { setScopeMode(v as "source" | "companies"); invalidate(); }}>
                <SelectTrigger data-testid="migrate-scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">Every tenant on a source version</SelectItem>
                  <SelectItem value="companies">Specific companies (ids)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {scopeMode === "source" ? (
              <div className="space-y-1.5">
                <Label>Source version</Label>
                <Select value={sourceId} onValueChange={(v) => { setSourceId(v); invalidate(); }}>
                  <SelectTrigger data-testid="migrate-source"><SelectValue placeholder="Pick the version to migrate from" /></SelectTrigger>
                  <SelectContent>
                    {sources.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>{versionLabel(v)} · {stateLabel(v)} · {v.subscribers} subscriber{v.subscribers === 1 ? "" : "s"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sources.length === 0 && <p className="text-xs text-muted-foreground">No other published version of this plan.</p>}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="migrate-companies">Company ids (comma or space separated, max 200)</Label>
                <Input id="migrate-companies" value={companyIdsRaw} onChange={(e) => { setCompanyIdsRaw(e.target.value); invalidate(); }} placeholder="12, 34, 56" data-testid="migrate-companies" />
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-md border px-3 py-2">
              <Checkbox checked={confirmFeatures} onCheckedChange={(v) => { setConfirmFeatures(v === true); invalidate(); }} data-testid="migrate-confirm-features" />
              <span>Confirm feature-only downgrades (D3): tenants that would lose features are migrated instead of reported.</span>
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="migrate-reason">Reason (recorded on every tenant's audit row)</Label>
              <Input id="migrate-reason" maxLength={200} value={reason} onChange={(e) => { setReason(e.target.value); invalidate(); }} data-testid="migrate-reason" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void runDry()} disabled={busy || !scopeReady} data-testid="migrate-dry-run">{busy && !dryRun ? "Evaluating…" : "Dry run (read-only)"}</Button>
            <Button onClick={() => void execute()} disabled={busy || !dryRun || !!result || dryRun.summary.eligible === 0} data-testid="migrate-execute">
              {busy && dryRun ? "Migrating…" : dryRun ? `Execute reviewed migration (${dryRun.summary.eligible} tenant${dryRun.summary.eligible === 1 ? "" : "s"})` : "Execute (dry run first)"}
            </Button>
            {dryRun && !result && <span className="font-mono text-xs text-muted-foreground" data-testid="migrate-digest">review {dryRun.digest.slice(0, 16)}…</span>}
          </div>
          {error && <p className="text-destructive" data-testid="migrate-error">{error}</p>}

          {shown && (
            <div className="space-y-2" data-testid={result ? "migrate-result" : "migrate-review"}>
              <div className="flex flex-wrap items-center gap-2" data-testid="migrate-summary">
                <Badge variant="secondary">{shown.summary.total} in scope</Badge>
                <StatusBadge tone={shown.summary.eligible > 0 ? "success" : "neutral"}>{shown.summary.eligible} eligible</StatusBadge>
                {Object.entries(shown.summary.byReason)
                  .filter(([k, n]) => k !== "ELIGIBLE" && n > 0)
                  .map(([k, n]) => (
                    <Badge key={k} variant="outline">{n} {REASON_LABEL[k] ?? k}</Badge>
                  ))}
                {result && (
                  <>
                    <StatusBadge tone="success">{result.summary.migrated} migrated</StatusBadge>
                    <StatusBadge tone="neutral">{result.summary.skipped} skipped</StatusBadge>
                    {result.summary.failed > 0 && <StatusBadge tone="destructive">{result.summary.failed} failed</StatusBadge>}
                    {result.summary.rolledBack > 0 && <StatusBadge tone="destructive">{result.summary.rolledBack} rolled back</StatusBadge>}
                    {result.summary.notAttempted > 0 && <StatusBadge tone="warning">{result.summary.notAttempted} not attempted</StatusBadge>}
                    <Badge variant={result.complete ? "default" : "destructive"} data-testid="migrate-complete">{result.complete ? "complete" : "incomplete"}</Badge>
                    {result.migrationId && <span className="font-mono text-xs text-muted-foreground">migration {result.migrationId.slice(0, 8)}</span>}
                  </>
                )}
              </div>
              <div className="overflow-x-auto">
                <Table data-testid="migrate-rows">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Current</TableHead>
                      <TableHead>Billing</TableHead>
                      <TableHead>Evaluation</TableHead>
                      {result && <TableHead>Outcome</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.rows.map((r: PlatformMigrationRow) => (
                      <TableRow key={r.companyId} data-testid={`migrate-row-${r.companyId}`} data-reason={r.reason} data-outcome={r.outcome}>
                        <TableCell>{r.companyName ?? `Company #${r.companyId}`}<span className="ml-1 text-xs text-muted-foreground">#{r.companyId}</span></TableCell>
                        <TableCell className="text-xs">{planRef(r.currentPlan, r.currentVersion)}{r.currentReferenceValid ? "" : " (invalid reference)"}{r.status ? ` · ${r.status}` : ""}</TableCell>
                        <TableCell className="text-xs">{r.billingSource === "stripe" ? "provider" : r.billingSource ?? "—"}</TableCell>
                        <TableCell className="text-xs">
                          <StatusBadge tone={r.reason === "ELIGIBLE" ? "success" : r.reason === "DOWNGRADE_BLOCKED" ? "destructive" : "neutral"}>{REASON_LABEL[r.reason] ?? r.reason}</StatusBadge>
                          {r.blocking.length > 0 && <div className="text-destructive">{r.blocking.map((b) => `${b.resource} ${b.used}/${b.limit}`).join(", ")}</div>}
                          {r.lostFeatures.length > 0 && <div className="text-muted-foreground">loses {r.lostFeatures.join(", ")}</div>}
                          {r.tightenedLimits.length > 0 && <div className="text-muted-foreground">tightens {r.tightenedLimits.join(", ")}</div>}
                          {r.unmeasurable.length > 0 && <div className="text-muted-foreground">unverified: {r.unmeasurable.join(", ")}</div>}
                        </TableCell>
                        {result && (
                          <TableCell className="text-xs">
                            <StatusBadge tone={outcomeTone(r.outcome)}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</StatusBadge>
                            {r.outcomeReason && r.outcome !== "migrated" && <div className="text-muted-foreground">{r.outcomeReason}</div>}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="ghost" onClick={close} disabled={busy} data-testid="migrate-close">Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
