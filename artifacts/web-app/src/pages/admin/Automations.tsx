import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  useGetWorkflowCatalog,
  getGetWorkflowCatalogQueryKey,
  useListWorkflowDefinitions,
  getListWorkflowDefinitionsQueryKey,
  usePublishWorkflowDefinition,
  useUnpublishWorkflowDefinition,
  useArchiveWorkflowDefinition,
  useDeleteWorkflowDefinition,
  type ListWorkflowDefinitionsParams,
  type WorkflowDefinition,
} from "@workspace/api-client-react";
import { PageHeader, EmptyState, ErrorState, TableSkeleton } from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { MoreHorizontal, Plus, Search, Workflow } from "lucide-react";
import { asCatalog, parseApiError, type Catalog } from "@/components/automations/catalog";
import { DefinitionStatusBadge, formatDateTime, formatRelative, triggerLabel } from "@/components/automations/format";
import { useWorkflowPermissions } from "@/components/automations/permissions";
import { RunHistory } from "@/components/automations/RunHistory";
import { Paginator } from "@/components/automations/Paginator";
import { LIFECYCLE_COPY, type LifecycleVerb } from "@/components/automations/lifecycle-copy";

const ALL = "__all__";
const PAGE_SIZE = 25;

interface PendingAction {
  verb: LifecycleVerb;
  definition: WorkflowDefinition;
}

function readSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

export default function AdminAutomations() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = readSearch(search);
  const tab = params.get("tab") === "runs" ? "runs" : "automations";
  const initialDefinition = params.get("definition");
  const { canView, canManage } = useWorkflowPermissions();

  const catalogQuery = useGetWorkflowCatalog({ query: { queryKey: getGetWorkflowCatalogQueryKey(), enabled: canView, staleTime: 5 * 60_000 } });
  const catalog: Catalog | undefined = catalogQuery.data ? asCatalog(catalogQuery.data) : undefined;

  const setTab = (next: string) => {
    navigate(next === "runs" ? "/admin/automations?tab=runs" : "/admin/automations", { replace: true });
  };

  if (!canView) {
    return (
      <div data-testid="automations-forbidden">
        <PageHeader title="Automations" description="Run CRM actions automatically when leads and contacts change." />
        <ErrorState title="You do not have access to automations" description="Ask a company administrator for the Workflows permission to view or manage automations." />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Automations"
        description="Run CRM actions automatically when leads and contacts change. Only active automations execute."
        actions={
          canManage && tab === "automations" ? (
            <Button asChild data-testid="button-new-automation">
              <Link href="/admin/automations/new">
                <Plus className="me-2 h-4 w-4" aria-hidden="true" /> New automation
              </Link>
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList aria-label="Automation workspace sections">
          <TabsTrigger value="automations" data-testid="tab-automations">
            Automations
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="tab-runs">
            Run History
          </TabsTrigger>
        </TabsList>
        {tab === "automations" ? (
          <AutomationList catalog={catalog} canManage={canManage} />
        ) : (
          <RunHistory catalog={catalog} initialDefinitionId={initialDefinition && /^\d+$/.test(initialDefinition) ? Number(initialDefinition) : undefined} />
        )}
      </Tabs>
    </div>
  );
}

function AutomationList({ catalog, canManage }: { catalog: Catalog | undefined; canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(ALL);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<PendingAction | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => setPage(1), [q, status, includeArchived]);

  const listParams = useMemo<ListWorkflowDefinitionsParams>(
    () => ({
      ...(q ? { q } : {}),
      ...(status !== ALL ? { status: status as ListWorkflowDefinitionsParams["status"] } : {}),
      // Archived rows are hidden unless the archived filter is on or the status filter asks for them.
      includeArchived: includeArchived || status === "archived",
      page,
      pageSize: PAGE_SIZE,
      sort: "updatedAt",
      order: "desc",
    }),
    [q, status, includeArchived, page],
  );

  const list = useListWorkflowDefinitions(listParams, { query: { queryKey: getListWorkflowDefinitionsQueryKey(listParams), placeholderData: keepPreviousData } });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListWorkflowDefinitionsQueryKey() });

  const onLifecycleError = (err: unknown, verb: LifecycleVerb) => {
    const parsed = parseApiError(err, `Could not ${verb} the automation`);
    if (parsed.status === 409 && parsed.code === "WORKFLOW_REVISION_CONFLICT") {
      toast({ title: "This automation changed in the meantime", description: "The list has been refreshed — review it and try again.", variant: "destructive" });
    } else {
      toast({ title: `Could not ${verb} the automation`, description: parsed.message, variant: "destructive" });
    }
    invalidate();
  };
  const onLifecycleSuccess = (verb: LifecycleVerb) => {
    toast({ title: LIFECYCLE_COPY[verb].success });
    invalidate();
  };

  const publish = usePublishWorkflowDefinition();
  const unpublish = useUnpublishWorkflowDefinition();
  const archive = useArchiveWorkflowDefinition();
  const remove = useDeleteWorkflowDefinition();
  const busy = publish.isPending || unpublish.isPending || archive.isPending || remove.isPending;

  const runPending = () => {
    if (!pending) return;
    const { verb, definition } = pending;
    const vars = { id: definition.id, data: { revision: definition.revision } };
    const opts = { onSuccess: () => onLifecycleSuccess(verb), onError: (e: unknown) => onLifecycleError(e, verb), onSettled: () => setPending(null) };
    if (verb === "publish") publish.mutate(vars, opts);
    else if (verb === "unpublish") unpublish.mutate(vars, opts);
    else if (verb === "archive") archive.mutate(vars, opts);
    else remove.mutate(vars, opts);
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtersActive = !!q || status !== ALL || includeArchived;
  const transitionsOf = (s: string) => catalog?.lifecycle?.[s]?.transitions ?? (s === "draft" ? ["published", "archived"] : s === "published" ? ["draft", "archived"] : []);
  const deletable = (s: string) => catalog?.lifecycle?.[s]?.deletable ?? s === "draft";

  return (
    <div className="space-y-4" data-testid="automation-list">
      <div className="flex flex-col gap-3 md:flex-row md:items-end" role="group" aria-label="Automation filters">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="automations-search" className="text-xs font-medium">
            Search
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id="automations-search" data-testid="automations-search" className="ps-9" placeholder="Search by name…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5 md:w-48">
          <Label htmlFor="automations-status-filter" className="text-xs font-medium">
            Status
          </Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="automations-status-filter" data-testid="automations-status-filter" className="w-full">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-10 items-center gap-2">
          <Checkbox id="automations-include-archived" data-testid="automations-include-archived" checked={includeArchived} onCheckedChange={(v) => setIncludeArchived(v === true)} />
          <Label htmlFor="automations-include-archived" className="text-sm font-normal">
            Show archived
          </Label>
        </div>
      </div>

      {list.isLoading ? (
        <TableSkeleton rows={6} />
      ) : list.isError ? (
        <ErrorState title="Could not load automations" description={parseApiError(list.error, "Please try again.").message} action={<Button type="button" variant="outline" onClick={() => list.refetch()}>Retry</Button>} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title={filtersActive ? "No automations match these filters" : "No automations yet"}
          description={filtersActive ? "Try a different search or status." : canManage ? "Create your first automation to run actions when leads or contacts change." : "Automations created by your administrators will appear here."}
          action={
            filtersActive ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearchInput("");
                  setStatus(ALL);
                  setIncludeArchived(false);
                }}
              >
                Clear filters
              </Button>
            ) : canManage ? (
              <Button asChild>
                <Link href="/admin/automations/new">
                  <Plus className="me-2 h-4 w-4" aria-hidden="true" /> New automation
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card" data-testid="automations-table">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">Name</TableHead>
                <TableHead className="text-start">Trigger</TableHead>
                <TableHead className="text-start">Actions</TableHead>
                <TableHead className="text-start">Status</TableHead>
                <TableHead className="text-start hidden md:table-cell">Revision</TableHead>
                <TableHead className="text-start">Last updated</TableHead>
                {canManage && (
                  <TableHead className="text-end">
                    <span className="sr-only">Row actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => {
                const transitions = transitionsOf(d.status);
                return (
                  <TableRow key={d.id} data-testid={`automation-row-${d.id}`} data-status={d.status}>
                    <TableCell className="max-w-[320px]">
                      <Link href={`/admin/automations/${d.id}`} className="font-medium text-foreground hover:underline" data-testid={`automation-link-${d.id}`}>
                        {d.name}
                      </Link>
                      {d.description && <p className="truncate text-xs text-muted-foreground">{d.description}</p>}
                    </TableCell>
                    <TableCell className="text-sm">{triggerLabel(catalog, d.trigger?.type)}</TableCell>
                    <TableCell className="text-sm tabular-nums">{d.actions?.length ?? 0}</TableCell>
                    <TableCell>
                      <DefinitionStatusBadge status={d.status} catalog={catalog} />
                    </TableCell>
                    <TableCell className="text-sm tabular-nums hidden md:table-cell">{d.revision}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      <span title={formatDateTime(d.updatedAt)}>{formatRelative(d.updatedAt)}</span>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${d.name}`} data-testid={`automation-menu-${d.id}`} disabled={busy}>
                              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => navigate(`/admin/automations/${d.id}`)}>{d.status === "draft" ? "Edit" : "View"}</DropdownMenuItem>
                            {transitions.includes("published") && <DropdownMenuItem data-testid={`automation-publish-${d.id}`} onSelect={() => setPending({ verb: "publish", definition: d })}>Publish</DropdownMenuItem>}
                            {transitions.includes("draft") && <DropdownMenuItem data-testid={`automation-unpublish-${d.id}`} onSelect={() => setPending({ verb: "unpublish", definition: d })}>Unpublish</DropdownMenuItem>}
                            {transitions.includes("archived") && <DropdownMenuItem data-testid={`automation-archive-${d.id}`} onSelect={() => setPending({ verb: "archive", definition: d })}>Archive</DropdownMenuItem>}
                            {deletable(d.status) && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive focus:text-destructive" data-testid={`automation-delete-${d.id}`} onSelect={() => setPending({ verb: "delete", definition: d })}>
                                  Delete draft
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {list.data && total > 0 && <Paginator page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} disabled={list.isFetching} testId="automations-paginator" />}

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <AlertDialogContent data-testid="lifecycle-dialog">
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{LIFECYCLE_COPY[pending.verb].title}</AlertDialogTitle>
                <AlertDialogDescription>
                  <span className="block font-medium text-foreground">{pending.definition.name}</span>
                  {LIFECYCLE_COPY[pending.verb].description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy} data-testid="lifecycle-cancel">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="lifecycle-confirm"
                  disabled={busy}
                  className={LIFECYCLE_COPY[pending.verb].destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    runPending();
                  }}
                >
                  {busy ? "Working…" : LIFECYCLE_COPY[pending.verb].confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
