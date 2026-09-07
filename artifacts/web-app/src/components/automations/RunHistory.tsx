import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useListWorkflowRuns,
  getListWorkflowRunsQueryKey,
  useListWorkflowDefinitions,
  getListWorkflowDefinitionsQueryKey,
  type ListWorkflowRunsParams,
  type WorkflowRun,
} from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ds";
import { History, RefreshCw } from "lucide-react";
import type { Catalog } from "./catalog";
import { parseApiError } from "./catalog";
import { RunStatusBadge, entityHref, entityLabel, formatDateTime, formatRelative, isActiveRunStatus, triggerLabel } from "./format";
import { Paginator } from "./Paginator";

const ALL = "__all__";
const PAGE_SIZE = 25;
const POLL_MS = 3000;
const DEFINITIONS = { includeArchived: true, pageSize: 100, sort: "name", order: "asc" } as const;

export interface RunHistoryProps {
  catalog: Catalog | undefined;
  /** Pre-selected automation (from `?definition=` or the editor's "View runs" link). */
  initialDefinitionId?: number;
}

/**
 * Batch 16 run history (read-only). Filters map 1:1 to GET /workflows/runs;
 * the list re-polls only while a visible run is still queued or running and
 * stops as soon as every row on the page is terminal. No run-now/replay/retry.
 */
export function RunHistory({ catalog, initialDefinitionId }: RunHistoryProps) {
  const [definitionId, setDefinitionId] = useState<string>(initialDefinitionId ? String(initialDefinitionId) : ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [triggerType, setTriggerType] = useState<string>(ALL);
  const [entityType, setEntityType] = useState<string>(ALL);
  const [entityIdInput, setEntityIdInput] = useState("");
  const [entityId, setEntityId] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      const n = parseInt(entityIdInput, 10);
      setEntityId(Number.isInteger(n) && n > 0 ? n : undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [entityIdInput]);

  // Any filter change returns to the first page.
  useEffect(() => setPage(1), [definitionId, status, triggerType, entityType, entityId]);

  const params = useMemo<ListWorkflowRunsParams>(
    () => ({
      ...(definitionId !== ALL ? { workflowDefinitionId: Number(definitionId) } : {}),
      ...(status !== ALL ? { status: status as ListWorkflowRunsParams["status"] } : {}),
      ...(triggerType !== ALL ? { triggerType } : {}),
      ...(entityType !== ALL ? { entityType: entityType as ListWorkflowRunsParams["entityType"] } : {}),
      ...(entityId ? { entityId } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [definitionId, status, triggerType, entityType, entityId, page],
  );

  const runs = useListWorkflowRuns(params, {
    query: {
      queryKey: getListWorkflowRunsQueryKey(params),
      placeholderData: keepPreviousData,
      refetchInterval: (query) => (query.state.data?.items?.some((r) => isActiveRunStatus(r.status)) ? POLL_MS : false),
    },
  });
  const definitions = useListWorkflowDefinitions(DEFINITIONS, { query: { queryKey: getListWorkflowDefinitionsQueryKey(DEFINITIONS), staleTime: 60_000 } });

  const items: WorkflowRun[] = runs.data?.items ?? [];
  const total = runs.data?.total ?? 0;
  const polling = items.some((r) => isActiveRunStatus(r.status));
  const filtersActive = definitionId !== ALL || status !== ALL || triggerType !== ALL || entityType !== ALL || !!entityId;

  const clearFilters = () => {
    setDefinitionId(ALL);
    setStatus(ALL);
    setTriggerType(ALL);
    setEntityType(ALL);
    setEntityIdInput("");
  };

  return (
    <div className="space-y-4" data-testid="run-history">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" role="group" aria-label="Run history filters">
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor="runs-filter-definition" className="text-xs font-medium">
            Automation
          </Label>
          <Select value={definitionId} onValueChange={setDefinitionId}>
            <SelectTrigger id="runs-filter-definition" data-testid="runs-filter-definition" className="w-full">
              <SelectValue placeholder="All automations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All automations</SelectItem>
              {(definitions.data?.items ?? []).map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor="runs-filter-status" className="text-xs font-medium">
            Status
          </Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="runs-filter-status" data-testid="runs-filter-status" className="w-full">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor="runs-filter-trigger" className="text-xs font-medium">
            Trigger
          </Label>
          <Select value={triggerType} onValueChange={setTriggerType}>
            <SelectTrigger id="runs-filter-trigger" data-testid="runs-filter-trigger" className="w-full">
              <SelectValue placeholder="Any trigger" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any trigger</SelectItem>
              {(catalog?.triggers ?? []).map((t) => (
                <SelectItem key={t.type} value={t.type}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor="runs-filter-entity-type" className="text-xs font-medium">
            Record type
          </Label>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger id="runs-filter-entity-type" data-testid="runs-filter-entity-type" className="w-full">
              <SelectValue placeholder="Leads and contacts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Leads and contacts</SelectItem>
              <SelectItem value="lead">Leads</SelectItem>
              <SelectItem value="contact">Contacts</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor="runs-filter-entity-id" className="text-xs font-medium">
            Record ID
          </Label>
          <Input id="runs-filter-entity-id" data-testid="runs-filter-entity-id" inputMode="numeric" placeholder="e.g. 42" value={entityIdInput} onChange={(e) => setEntityIdInput(e.target.value.replace(/[^0-9]/g, ""))} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="runs-polling">
          {polling ? (
            <span className="inline-flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> Refreshing every {POLL_MS / 1000} seconds while runs are queued or running
            </span>
          ) : runs.data ? (
            "All runs shown are finished. History is read-only — runs are never re-executed from here."
          ) : (
            ""
          )}
        </p>
        {filtersActive && (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters} data-testid="runs-clear-filters">
            Clear filters
          </Button>
        )}
      </div>

      {runs.isLoading ? (
        <TableSkeleton rows={6} />
      ) : runs.isError ? (
        <ErrorState title="Could not load run history" description={parseApiError(runs.error, "Please try again.").message} action={<Button type="button" variant="outline" onClick={() => runs.refetch()}>Retry</Button>} />
      ) : items.length === 0 ? (
        <EmptyState icon={History} title={filtersActive ? "No runs match these filters" : "No runs yet"} description={filtersActive ? "Try widening the filters." : "Runs appear here when an active automation executes for a matching CRM event."} action={filtersActive ? <Button type="button" variant="outline" onClick={clearFilters}>Clear filters</Button> : undefined} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card" data-testid="runs-table">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">Automation</TableHead>
                <TableHead className="text-start">Trigger</TableHead>
                <TableHead className="text-start">Record</TableHead>
                <TableHead className="text-start">Status</TableHead>
                <TableHead className="text-start">Queued</TableHead>
                <TableHead className="text-start hidden lg:table-cell">Completed</TableHead>
                <TableHead className="text-start">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => {
                const href = entityHref(r.entityType, r.entityId);
                const s = r.actionSummary;
                return (
                  <TableRow key={r.id} data-testid={`run-row-${r.id}`} data-status={r.status}>
                    <TableCell className="max-w-[260px]">
                      <Link href={`/admin/automations/runs/${r.id}`} className="font-medium text-foreground hover:underline" data-testid={`run-link-${r.id}`}>
                        {r.workflowName ?? "Deleted automation"}
                      </Link>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Run #{r.id} · rev {r.definitionRevision}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">{triggerLabel(catalog, r.triggerType)}</TableCell>
                    <TableCell className="text-sm">
                      {href ? (
                        <Link href={href} className="hover:underline" data-testid={`run-entity-${r.id}`}>
                          {entityLabel(r.entityType)} #{r.entityId}
                        </Link>
                      ) : (
                        <span>
                          {entityLabel(r.entityType)} #{r.entityId}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      <span title={formatDateTime(r.queuedAt)}>{formatRelative(r.queuedAt)}</span>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap hidden lg:table-cell">{formatDateTime(r.completedAt)}</TableCell>
                    <TableCell className="text-sm tabular-nums whitespace-nowrap">
                      <span title={`${s.completed} completed, ${s.skipped} skipped, ${s.failed} failed of ${s.total}`}>
                        {s.completed}/{s.total} done
                        {s.skipped > 0 && <span className="text-muted-foreground"> · {s.skipped} skipped</span>}
                        {s.failed > 0 && <span className="text-destructive"> · {s.failed} failed</span>}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {runs.data && total > 0 && <Paginator page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} disabled={runs.isFetching} testId="runs-paginator" />}
    </div>
  );
}
