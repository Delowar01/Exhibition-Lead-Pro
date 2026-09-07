import { Link, useParams } from "wouter";
import { useMemo } from "react";
import {
  useGetWorkflowCatalog,
  getGetWorkflowCatalogQueryKey,
  useGetWorkflowRun,
  getGetWorkflowRunQueryKey,
  useListUsers,
  getListUsersQueryKey,
  useListTags,
  getListTagsQueryKey,
  type WorkflowActionRun,
} from "@workspace/api-client-react";
import { PageHeader, ErrorState, ListSkeleton } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { asCatalog, parseApiError } from "@/components/automations/catalog";
import { RunStatusBadge, actionLabel, durationBetween, entityHref, entityLabel, formatDateTime, humanize, isActiveRunStatus, safeEntries, triggerLabel } from "@/components/automations/format";
import { useWorkflowPermissions } from "@/components/automations/permissions";

const POLL_MS = 3000;
const USERS = { limit: 200 } as const;
const CRUMBS = [
  { label: "Automations", href: "/admin/automations" },
  { label: "Run History", href: "/admin/automations?tab=runs" },
];

/** Turns sanitized result ids (tagId, assignedToId, userId) into names the reader recognises; unknown ids stay as "#id". */
type Resolve = (key: string, value: string) => string;

function KeyValueList({ entries, testId, resolve }: { entries: Array<[string, string]>; testId?: string; resolve?: Resolve }) {
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid={testId}>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{humanize(k)}</dt>
          <dd className="break-words">{resolve ? resolve(k, v) : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function useNameResolver(enabled: boolean): { resolve: Resolve; userName: (id: number | null | undefined) => string } {
  const users = useListUsers(USERS, { query: { enabled, queryKey: getListUsersQueryKey(USERS), staleTime: 60_000 } });
  const tags = useListTags({ query: { enabled, queryKey: getListTagsQueryKey(), staleTime: 60_000 } });
  return useMemo(() => {
    const userMap = new Map((users.data?.users ?? []).map((u) => [u.id, u.name || u.email]));
    const tagMap = new Map((tags.data?.tags ?? []).map((t) => [t.id, t.name]));
    const userName = (id: number | null | undefined) => (id == null ? "System" : userMap.get(id) ?? `User #${id}`);
    const resolve: Resolve = (key, value) => {
      const n = Number(value);
      if (!Number.isInteger(n)) return value;
      if (key === "tagId") return tagMap.get(n) ? `${tagMap.get(n)} (#${n})` : `#${n}`;
      if (key === "assignedToId" || key === "userId" || key === "recipientUserId") return userMap.get(n) ? `${userMap.get(n)} (#${n})` : `User #${n}`;
      if (/Id$/.test(key)) return `#${n}`;
      return value;
    };
    return { resolve, userName };
  }, [users.data, tags.data]);
}

function ActionOutcome({ action, label, resolve }: { action: WorkflowActionRun; label: string; resolve: Resolve }) {
  const result = (action.result ?? null) as Record<string, unknown> | null;
  const skipReason = action.status === "skipped" && result && typeof result.reason === "string" ? result.reason : null;
  const resultEntries = safeEntries(result).filter(([k]) => !(skipReason && k === "reason"));
  const errorEntries = safeEntries(action.error ?? null);
  const duration = durationBetween(action.startedAt, action.completedAt);
  return (
    <li className={cn("rounded-lg border border-border bg-muted/20 p-3", action.status === "failed" && "border-destructive/50")} data-testid={`run-action-${action.actionIndex}`} data-status={action.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums" aria-hidden="true">
            {action.actionIndex + 1}
          </span>
          <p className="truncate text-sm font-semibold">
            <span className="sr-only">Action {action.actionIndex + 1}: </span>
            {label}
          </p>
        </div>
        <RunStatusBadge status={action.status} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground tabular-nums">
        {action.attempts} {action.attempts === 1 ? "attempt" : "attempts"}
        {action.startedAt && <> · started {formatDateTime(action.startedAt)}</>}
        {action.completedAt && <> · finished {formatDateTime(action.completedAt)}</>}
        {duration && <> · {duration}</>}
      </p>
      {skipReason && (
        <p className="mt-2 rounded-md bg-warning-soft px-2 py-1 text-xs text-foreground" data-testid={`run-action-${action.actionIndex}-skip`}>
          Skipped: {skipReason}
        </p>
      )}
      {resultEntries.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium">Result</p>
          <KeyValueList entries={resultEntries} testId={`run-action-${action.actionIndex}-result`} resolve={resolve} />
        </div>
      )}
      {errorEntries.length > 0 && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive-soft p-2" role="note">
          <p className="text-xs font-medium text-destructive">Error</p>
          <KeyValueList entries={errorEntries} testId={`run-action-${action.actionIndex}-error`} />
        </div>
      )}
    </li>
  );
}

export default function AdminAutomationRunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const validId = Number.isInteger(runId) && runId > 0;
  const { canView } = useWorkflowPermissions();

  const catalogQuery = useGetWorkflowCatalog({ query: { queryKey: getGetWorkflowCatalogQueryKey(), enabled: canView, staleTime: 5 * 60_000 } });
  const catalog = catalogQuery.data ? asCatalog(catalogQuery.data) : undefined;
  const names = useNameResolver(canView && validId);
  const runQuery = useGetWorkflowRun(runId, {
    query: {
      queryKey: getGetWorkflowRunQueryKey(runId),
      enabled: canView && validId,
      refetchInterval: (query) => (isActiveRunStatus(query.state.data?.status) ? POLL_MS : false),
    },
  });

  if (!canView) {
    return (
      <div data-testid="automations-forbidden">
        <PageHeader title="Run" breadcrumbs={[...CRUMBS, { label: "Run" }]} />
        <ErrorState title="You do not have access to automations" description="Ask a company administrator for the Workflows permission." />
      </div>
    );
  }
  if (!validId || (runQuery.isError && parseApiError(runQuery.error).status === 404)) {
    return (
      <div>
        <PageHeader title="Run not found" breadcrumbs={[...CRUMBS, { label: "Not found" }]} />
        <ErrorState title="Run not found" description="This run does not exist in your company." action={<Button asChild variant="outline"><Link href="/admin/automations?tab=runs">Back to run history</Link></Button>} />
      </div>
    );
  }
  if (runQuery.isError) {
    return (
      <div>
        <PageHeader title="Run" breadcrumbs={[...CRUMBS, { label: `Run #${runId}` }]} />
        <ErrorState title="Could not load this run" description={parseApiError(runQuery.error, "Please try again.").message} action={<Button type="button" variant="outline" onClick={() => runQuery.refetch()}>Retry</Button>} />
      </div>
    );
  }
  const run = runQuery.data;
  if (!run) {
    return (
      <div>
        <PageHeader title={`Run #${runId}`} breadcrumbs={[...CRUMBS, { label: `Run #${runId}` }]} />
        <ListSkeleton rows={6} />
      </div>
    );
  }

  const active = isActiveRunStatus(run.status);
  const href = entityHref(run.entityType, run.entityId);
  const errorEntries = safeEntries(run.error ?? null);
  const s = run.actionSummary;

  return (
    <div className="min-w-0" data-testid="run-detail" data-status={run.status}>
      <PageHeader
        title={run.workflowName ?? "Deleted automation"}
        breadcrumbs={[...CRUMBS, { label: `Run #${run.id}` }]}
        description={`Run #${run.id} · definition revision ${run.definitionRevision}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} className="text-sm" />
            {run.workflowDefinitionId != null && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/automations/${run.workflowDefinitionId}`} data-testid="run-definition-link">
                  Open automation
                </Link>
              </Button>
            )}
          </div>
        }
      />

      <p className="mb-4 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="run-polling">
        {active ? (
          <span className="inline-flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> This run is {run.status}; refreshing every {POLL_MS / 1000} seconds.
          </span>
        ) : (
          "This run has finished. Run history is read-only and is never re-executed from here."
        )}
      </p>

      {errorEntries.length > 0 && (
        <Alert variant="destructive" className="mb-4" data-testid="run-error">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>
            <KeyValueList entries={errorEntries} />
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="rounded-xl border-border shadow-sm lg:sticky lg:top-6 lg:self-start">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <RunStatusBadge status={run.status} />
                <span className="sr-only" data-testid="run-detail-status">
                  {run.status}
                </span>
              </dd>
              <dt className="text-muted-foreground">Trigger</dt>
              <dd>{triggerLabel(catalog, run.triggerType)}</dd>
              <dt className="text-muted-foreground">Record</dt>
              <dd>
                {href ? (
                  <Link href={href} className="hover:underline" data-testid="run-entity-link">
                    {entityLabel(run.entityType)} #{run.entityId}
                  </Link>
                ) : (
                  <span>
                    {entityLabel(run.entityType)} #{run.entityId}
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Actions</dt>
              <dd className="tabular-nums" data-testid="run-action-summary">
                {s.completed} completed · {s.skipped} skipped · {s.failed} failed of {s.total}
              </dd>
              <dt className="text-muted-foreground">Queued</dt>
              <dd>{formatDateTime(run.queuedAt)}</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{formatDateTime(run.startedAt)}</dd>
              <dt className="text-muted-foreground">Completed</dt>
              <dd>{formatDateTime(run.completedAt)}</dd>
              {durationBetween(run.startedAt, run.completedAt) && (
                <>
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd>{durationBetween(run.startedAt, run.completedAt)}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Triggered by</dt>
              <dd data-testid="run-actor">{names.userName(run.actorUserId)}</dd>
              <dt className="text-muted-foreground">Event key</dt>
              <dd className="break-all font-mono text-xs">{run.eventKey}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-border shadow-sm min-w-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Action outcomes</CardTitle>
            <CardDescription>Executed in order from the definition snapshot captured when the run was queued.</CardDescription>
          </CardHeader>
          <CardContent>
            {run.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No actions were recorded for this run.</p>
            ) : (
              <ol className="space-y-3" aria-label="Action outcomes in execution order">
                {run.actions
                  .slice()
                  .sort((a, b) => a.actionIndex - b.actionIndex)
                  .map((a) => (
                    <ActionOutcome key={a.id} action={a} label={actionLabel(catalog, a.actionType)} resolve={names.resolve} />
                  ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
