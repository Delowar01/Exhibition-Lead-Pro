import { useMemo, useState } from "react";
import {
  useGetLeadPipeline,
  useListPipelineStages,
  useListUsers,
  useListTeams,
  useListEvents,
  useListTags,
  useListSavedSearches,
  useCreateSavedSearch,
  useDeleteSavedSearch,
  getListSavedSearchesQueryKey,
  type PipelineView,
  type SavedSearch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  SortingState,
  VisibilityState,
  ColumnPinningState,
} from "@tanstack/react-table";
import { CheckSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { ImportWizard } from "@/components/import-export/ImportWizard";
import { useImportExportPermissions } from "@/components/import-export/usePermissions";
import { KpiCards } from "@/components/pipeline/KpiCards";
import { PipelineToolbar } from "@/components/pipeline/PipelineToolbar";
import { AdvancedFilters } from "@/components/pipeline/AdvancedFilters";
import { LeadsTable } from "@/components/pipeline/LeadsTable";
import { KanbanBoard } from "@/components/pipeline/KanbanBoard";
import { LeadDrawer } from "@/components/pipeline/LeadDrawer";
import { BulkBar } from "@/components/pipeline/BulkBar";
import {
  BRAND,
  EMPTY_FILTERS,
  applyFilters,
  activeFilterCount,
  buildStageMap,
  computePipelineStats,
  formatMoney,
  normalizeViewState,
  type GroupBy,
  type LeadFilters,
  type PipelineViewState,
  type ViewMode,
} from "@/components/pipeline/utils";

const DEFAULT_PINNING: ColumnPinningState = { left: ["select", "contact"], right: ["actions"] };
const LEAD_VIEW_ENTITY = "lead";

export default function AdminLeads() {
  const { data: pipeline, isLoading } = useGetLeadPipeline();
  const { data: stagesData, isLoading: stagesLoading } = useListPipelineStages();
  const { data: usersData } = useListUsers({ limit: 200 });
  const { data: teamsData } = useListTeams();
  const { data: eventsData } = useListEvents();
  const { data: tagsData } = useListTags();
  const { data: savedData } = useListSavedSearches();
  const createSavedSearch = useCreateSavedSearch();
  const deleteSavedSearch = useDeleteSavedSearch();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { canExport, canImportLeads } = useImportExportPermissions();

  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>(DEFAULT_PINNING);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [drawerLeadId, setDrawerLeadId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [currentViewName, setCurrentViewName] = useState<string | null>(null);

  const stages = useMemo(
    () => [...(stagesData?.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [stagesData]
  );
  const stageMap = useMemo(() => buildStageMap(stages), [stages]);
  const users = usersData?.users ?? [];
  const teams = teamsData?.teams ?? [];
  const events = eventsData?.events ?? [];
  const tags = tagsData?.tags ?? [];

  const allLeads = useMemo(() => (pipeline?.stages ?? []).flatMap((s) => s.leads), [pipeline]);
  const filtered = useMemo(() => applyFilters(allLeads, filters, stageMap), [allLeads, filters, stageMap]);
  const filteredIds = useMemo(() => new Set(filtered.map((l) => l.id)), [filtered]);

  const filteredView = useMemo<PipelineView>(() => {
    const src = pipeline?.stages ?? [];
    return {
      totalValue: pipeline?.totalValue,
      stages: src.map((s) => {
        const leads = s.leads.filter((l) => filteredIds.has(l.id));
        return { stage: s.stage, leads, count: leads.length, value: leads.reduce((a, l) => a + (l.value ?? 0), 0) };
      }),
    };
  }, [pipeline, filteredIds]);

  const stats = useMemo(() => computePipelineStats(filtered, stageMap), [filtered, stageMap]);

  const savedViews = useMemo<SavedSearch[]>(
    () => (savedData?.savedSearches ?? []).filter((s) => s.entityType === LEAD_VIEW_ENTITY && s.kind === "view"),
    [savedData]
  );

  const updateFilters = (patch: Partial<LeadFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setCurrentViewName(null);
  };
  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setCurrentViewName(null);
  };

  const toggleSelect = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (ids: number[], select: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  const openLead = (id: number) => {
    setDrawerLeadId(id);
    setDrawerOpen(true);
  };

  const applyView = (v: SavedSearch) => {
    const p = normalizeViewState(v.payload);
    if (p.viewMode) setViewMode(p.viewMode);
    if (p.groupBy) setGroupBy(p.groupBy);
    setFilters(p.filters ?? EMPTY_FILTERS);
    setSorting((p.sorting as SortingState) ?? []);
    setColumnVisibility(p.columnVisibility ?? {});
    setColumnPinning((p.columnPinning as ColumnPinningState) ?? DEFAULT_PINNING);
    setCurrentViewName(v.name);
  };

  const saveView = (name: string) => {
    const payload: PipelineViewState = {
      viewMode,
      groupBy,
      filters,
      sorting: sorting.map((s) => ({ id: s.id, desc: s.desc })),
      columnVisibility,
      columnPinning: { left: columnPinning.left ?? [], right: columnPinning.right ?? [] },
    };
    createSavedSearch.mutate(
      { data: { name, kind: "view", entityType: LEAD_VIEW_ENTITY, payload } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListSavedSearchesQueryKey() });
          setCurrentViewName(name);
          toast({ title: "View saved", description: `"${name}" is now available.` });
        },
        onError: () => toast({ title: "Could not save view", variant: "destructive" }),
      }
    );
  };

  const deleteView = (id: number) => {
    deleteSavedSearch.mutate(
      { id },
      {
        onSuccess: () => qc.invalidateQueries({ queryKey: getListSavedSearchesQueryKey() }),
        onError: () => toast({ title: "Could not delete view", variant: "destructive" }),
      }
    );
  };

  const myLeadsActive = user?.id != null && filters.ownerId === user.id;

  if (isLoading || stagesLoading) {
    return <div className="flex h-full items-center justify-center p-8 text-muted-foreground">Loading pipeline...</div>;
  }

  return (
    <div className="flex h-full flex-col gap-4 pb-4">
      {/* Brand header */}
      <div className="flex flex-shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-6 w-1.5 rounded-full" style={{ backgroundColor: BRAND.orange }} />
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: BRAND.navy }}>
              <span className="dark:text-foreground">Lead Capture Pro</span>
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Enterprise Sales Workspace &middot; {stats.totalCount} leads &middot; Open pipeline{" "}
            <span className="font-semibold" style={{ color: BRAND.orange }}>
              {formatMoney(stats.totalPipelineValue, stats.currency, { compact: true })}
            </span>
          </p>
        </div>
        {viewMode === "kanban" && (
          <Button
            variant={selectMode ? "default" : "outline"}
            onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
            data-testid="button-select-mode"
            style={selectMode ? { backgroundColor: BRAND.navy } : undefined}
            className={selectMode ? "text-white" : undefined}
          >
            {selectMode ? <X className="mr-2 h-4 w-4" /> : <CheckSquare className="mr-2 h-4 w-4" />}
            {selectMode ? "Cancel" : "Select"}
          </Button>
        )}
      </div>

      <KpiCards leads={filtered} stageMap={stageMap} />

      <PipelineToolbar
        search={filters.search}
        onSearch={(v) => updateFilters({ search: v })}
        viewMode={viewMode}
        onViewMode={setViewMode}
        groupBy={groupBy}
        onGroupBy={(g) => {
          setGroupBy(g);
          setCurrentViewName(null);
        }}
        columnVisibility={columnVisibility}
        onToggleColumn={(id, visible) => setColumnVisibility((prev) => ({ ...prev, [id]: visible }))}
        onOpenFilters={() => setFiltersOpen(true)}
        activeFilterCount={activeFilterCount(filters)}
        onResetFilters={resetFilters}
        savedViews={savedViews}
        currentViewName={currentViewName}
        onApplyView={applyView}
        onDeleteView={deleteView}
        onSaveView={saveView}
        canImportLeads={canImportLeads}
        canExport={canExport}
        onImport={() => setImportOpen(true)}
        onExport={() => setExportOpen(true)}
        newLeadHref="/admin/scan"
      />

      {/* Quick preset chips */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
        {[
          { key: "open", label: "Open", active: filters.status === "open", apply: () => updateFilters({ status: filters.status === "open" ? "all" : "open" }) },
          { key: "won", label: "Won", active: filters.status === "won", apply: () => updateFilters({ status: filters.status === "won" ? "all" : "won" }) },
          { key: "high", label: "High priority", active: filters.priority === "high", apply: () => updateFilters({ priority: filters.priority === "high" ? null : "high" }) },
          { key: "mine", label: "My leads", active: !!myLeadsActive, apply: () => updateFilters({ ownerId: myLeadsActive ? null : (user?.id ?? null) }) },
        ].map((chip) => (
          <button
            key={chip.key}
            type="button"
            data-testid={`preset-${chip.key}`}
            onClick={chip.apply}
            className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
            style={
              chip.active
                ? { backgroundColor: BRAND.orangeSoft, borderColor: BRAND.orange, color: BRAND.orange }
                : { borderColor: `${BRAND.navy}22` }
            }
          >
            {chip.label}
          </button>
        ))}
      </div>

      {selectedIds.size > 0 && (
        <BulkBar selectedIds={selectedIds} users={users} teams={teams} stages={stages} onClear={clearSelection} />
      )}

      {viewMode === "table" ? (
        <LeadsTable
          leads={filtered}
          stageMap={stageMap}
          stages={stages}
          groupBy={groupBy}
          sorting={sorting}
          onSortingChange={setSorting}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          columnPinning={columnPinning}
          onColumnPinningChange={setColumnPinning}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAll}
          onOpenLead={openLead}
        />
      ) : (
        <KanbanBoard
          view={filteredView}
          stages={stages}
          stageMap={stageMap}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onOpenLead={openLead}
        />
      )}

      <AdvancedFilters
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        onChange={updateFilters}
        onReset={resetFilters}
        stages={stages}
        users={users}
        teams={teams}
        events={events}
        tags={tags}
      />

      <LeadDrawer
        leadId={drawerLeadId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        stageMap={stageMap}
        stages={stages}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        entityType="lead"
        filters={{
          stage: filters.stages.length === 1 ? filters.stages[0] : undefined,
          assignedToId: filters.ownerId != null ? String(filters.ownerId) : undefined,
          eventId: filters.eventId != null ? String(filters.eventId) : undefined,
        }}
      />
      <ImportWizard open={importOpen} onOpenChange={setImportOpen} entityType="lead" />
    </div>
  );
}
