import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "wouter";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  type ColumnPinningState,
  type Column,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseISO, format } from "date-fns";
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  MoreVertical,
  Eye,
  ExternalLink,
  Trash2,
  Pin,
  PinOff,
  Building2,
} from "lucide-react";
import {
  useDeleteLead,
  getGetLeadPipelineQueryKey,
  type Lead,
  type PipelineStageConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusBadge } from "@/components/ds";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { StageBadge } from "./StageBadge";
import {
  companyName,
  displayName,
  formatMoney,
  groupInfo,
  PRIORITY_META,
  statusOf,
  stageLabel,
  type GroupBy,
  type StageMap,
} from "./utils";

const ROW_H = 52;
const GROUP_H = 44;
const DASH = "\u2014";

interface LeadsTableProps {
  leads: Lead[];
  stageMap: StageMap;
  stages: PipelineStageConfig[];
  groupBy: GroupBy;
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  columnVisibility: VisibilityState;
  onColumnVisibilityChange: (v: VisibilityState) => void;
  columnPinning: ColumnPinningState;
  onColumnPinningChange: (p: ColumnPinningState) => void;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onToggleAll: (ids: number[], select: boolean) => void;
  onOpenLead: (id: number) => void;
}

type FlatItem =
  | { type: "group"; key: string; label: string; count: number; value: number }
  | { type: "row"; row: Row<Lead> };

function pinStyle(column: Column<Lead>): CSSProperties {
  const pinned = column.getIsPinned();
  if (!pinned) return {};
  return {
    position: "sticky",
    left: pinned === "left" ? column.getStart("left") : undefined,
    right: pinned === "right" ? column.getAfter("right") : undefined,
    zIndex: 2,
  };
}

const Muted = () => <span className="text-muted-foreground">{DASH}</span>;

export function LeadsTable(props: LeadsTableProps) {
  const { leads, stageMap, stages, groupBy } = props;
  const qc = useQueryClient();
  const { toast } = useToast();
  const deleteLead = useDeleteLead();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingDelete, setPendingDelete] = useState<Lead | null>(null);

  const doDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    deleteLead.mutate(
      { id },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
          toast({ title: "Lead deleted" });
        },
        onError: () => toast({ title: "Delete failed", variant: "destructive" }),
      }
    );
  };

  const columns = useMemo<ColumnDef<Lead>[]>(() => {
    return [
      {
        id: "select",
        size: 44,
        enableSorting: false,
        enableResizing: false,
        header: () => {
          const ids = leads.map((l) => l.id);
          const all = ids.length > 0 && ids.every((id) => props.selectedIds.has(id));
          const some = ids.some((id) => props.selectedIds.has(id));
          return (
            <Checkbox
              checked={all ? true : some ? "indeterminate" : false}
              onCheckedChange={(v) => props.onToggleAll(ids, !!v)}
              aria-label="Select all"
              data-testid="checkbox-select-all"
            />
          );
        },
        cell: ({ row }) => (
          <Checkbox
            checked={props.selectedIds.has(row.original.id)}
            onCheckedChange={() => props.onToggleSelect(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label="Select row"
            data-testid={`checkbox-row-${row.original.id}`}
          />
        ),
      },
      {
        id: "contact",
        header: "Contact",
        size: 230,
        accessorFn: (l) => displayName(l),
        cell: ({ row }) => {
          const l = row.original;
          return (
            <div className="min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpenLead(l.id);
                }}
                className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:underline"
                data-testid={`link-lead-${l.id}`}
              >
                {displayName(l)}
              </button>
              {l.contactEmail && <div className="truncate text-xs text-muted-foreground">{l.contactEmail}</div>}
            </div>
          );
        },
      },
      {
        id: "company",
        header: "Company",
        size: 180,
        accessorFn: (l) => companyName(l) ?? "",
        cell: ({ row }) => {
          const c = companyName(row.original);
          const hasOrg = !!row.original.organizationId;
          return c ? (
            <div className="flex items-center gap-1.5">
              {hasOrg && (
                <span title="Linked to Organization" className="flex-shrink-0">
                  <Building2 className="h-3 w-3 text-primary" aria-label="Linked to Organization" />
                </span>
              )}
              <span className="truncate text-sm">{c}</span>
            </div>
          ) : (
            <Muted />
          );
        },
      },
      {
        id: "event",
        header: "Event",
        size: 150,
        accessorFn: (l) => l.eventName ?? "",
        cell: ({ row }) => (row.original.eventName ? <span className="truncate text-sm">{row.original.eventName}</span> : <Muted />),
      },
      {
        id: "value",
        header: "Deal Value",
        size: 130,
        accessorFn: (l) => l.value ?? 0,
        cell: ({ row }) => {
          const m = formatMoney(row.original.value, row.original.currency);
          return m ? (
            <span className="text-sm font-semibold text-foreground">{m}</span>
          ) : (
            <Muted />
          );
        },
      },
      {
        id: "stage",
        header: "Stage",
        size: 160,
        accessorFn: (l) => stageLabel(l, stageMap),
        cell: ({ row }) => <StageBadge lead={row.original} stageMap={stageMap} stages={stages} />,
      },
      {
        id: "owner",
        header: "Owner",
        size: 150,
        accessorFn: (l) => l.assignedToName ?? "",
        cell: ({ row }) =>
          row.original.assignedToName ? <span className="truncate text-sm">{row.original.assignedToName}</span> : <span className="text-xs text-muted-foreground">Unassigned</span>,
      },
      {
        id: "team",
        header: "Team",
        size: 140,
        accessorFn: (l) => l.teamName ?? "",
        cell: ({ row }) => (row.original.teamName ? <span className="truncate text-sm">{row.original.teamName}</span> : <Muted />),
      },
      {
        id: "priority",
        header: "Priority",
        size: 120,
        accessorFn: (l) => l.priority ?? "",
        cell: ({ row }) => {
          const p = row.original.priority ? PRIORITY_META[row.original.priority] : null;
          return p ? (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${p.badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} />
              {p.label}
            </span>
          ) : (
            <Muted />
          );
        },
      },
      {
        id: "aiScore",
        header: "AI Score",
        size: 100,
        enableSorting: false,
        cell: ({ row }) => {
          const score = (row.original as any).aiScore ?? (row.original as any).leadScore;
          const temp = (row.original as any).temperature ?? (row.original as any).leadTemperature;
          if (score == null && !temp) return <Muted />;
          return (
            <div className="flex items-center gap-1.5">
              {score != null && <span className="text-xs font-semibold">{score}</span>}
              {temp === "hot" && <span className="h-2 w-2 rounded-full bg-destructive" title="Hot" />}
              {temp === "warm" && <span className="h-2 w-2 rounded-full bg-warning" title="Warm" />}
              {temp === "cold" && <span className="h-2 w-2 rounded-full bg-info" title="Cold" />}
            </div>
          );
        },
      },
      {
        id: "lastActivity",
        header: "Last Activity",
        size: 140,
        enableSorting: false,
        cell: ({ row }) => {
          const activity = (row.original as any).lastActivityAt ?? (row.original as any).updatedAt;
          if (!activity) return <Muted />;
          return <span className="text-xs">{format(parseISO(activity), "MMM d, yyyy")}</span>;
        },
      },
      {
        id: "nextFollowUp",
        header: "Next Follow-up",
        size: 140,
        enableSorting: false,
        cell: ({ row }) => {
          const next = (row.original as any).nextFollowUp ?? (row.original as any).followUpDate;
          if (!next) return <Muted />;
          return <span className="text-xs">{format(parseISO(next), "MMM d, yyyy")}</span>;
        },
      },
      {
        id: "expectedClose",
        header: "Expected Close",
        size: 140,
        accessorFn: (l) => l.closingDate ?? "",
        cell: ({ row }) =>
          row.original.closingDate ? <span className="text-sm">{format(parseISO(row.original.closingDate), "MMM d, yyyy")}</span> : <Muted />,
      },
      {
        id: "tags",
        header: "Tags",
        size: 180,
        enableSorting: false,
        cell: ({ row }) => {
          const tags = row.original.tags ?? [];
          if (tags.length === 0) return <Muted />;
          return (
            <div className="flex items-center gap-1">
              {tags.slice(0, 2).map((t) => (
                <span
                  key={t.id}
                  className={t.color ? "truncate rounded-full border px-1.5 py-0.5 text-[10px]" : "truncate rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"}
                  style={t.color ? { borderColor: `${t.color}55`, color: t.color } : undefined}
                >
                  {t.name}
                </span>
              ))}
              {tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        size: 110,
        accessorFn: (l) => statusOf(l, stageMap),
        cell: ({ row }) => {
          const s = statusOf(row.original, stageMap);
          const tone = s === "won" ? "success" : s === "lost" ? "neutral" : "info";
          const label = s === "all" ? "Open" : s === "won" ? "Won" : s === "lost" ? "Lost" : "Open";
          return <StatusBadge tone={tone}>{label}</StatusBadge>;
        },
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => {
          const l = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  data-testid={`button-row-menu-${l.id}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => props.onOpenLead(l.id)}>
                  <Eye className="mr-2 h-4 w-4" />
                  Quick view
                </DropdownMenuItem>
                <Link href={`/admin/leads/${l.id}`}>
                  <DropdownMenuItem>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open full record
                  </DropdownMenuItem>
                </Link>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPendingDelete(l)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, stageMap, stages, props.selectedIds]);

  const table = useReactTable({
    data: leads,
    columns,
    state: {
      sorting: props.sorting,
      columnVisibility: props.columnVisibility,
      columnPinning: props.columnPinning,
    },
    onSortingChange: (u) => props.onSortingChange(typeof u === "function" ? u(props.sorting) : u),
    onColumnVisibilityChange: (u) =>
      props.onColumnVisibilityChange(typeof u === "function" ? u(props.columnVisibility) : u),
    onColumnPinningChange: (u) =>
      props.onColumnPinningChange(typeof u === "function" ? u(props.columnPinning) : u),
    getRowId: (row) => String(row.id),
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const sortedRows = table.getRowModel().rows;

  const flatItems = useMemo<FlatItem[]>(() => {
    if (groupBy === "none") return sortedRows.map((row) => ({ type: "row" as const, row }));
    const order: string[] = [];
    const groups = new Map<string, { label: string; rows: Row<Lead>[]; value: number }>();
    for (const row of sortedRows) {
      const g = groupInfo(row.original, groupBy, stageMap);
      if (!groups.has(g.key)) {
        groups.set(g.key, { label: g.label, rows: [], value: 0 });
        order.push(g.key);
      }
      const bucket = groups.get(g.key)!;
      bucket.rows.push(row);
      bucket.value += row.original.value ?? 0;
    }
    const items: FlatItem[] = [];
    for (const key of order) {
      const b = groups.get(key)!;
      items.push({ type: "group", key, label: b.label, count: b.rows.length, value: b.value });
      for (const row of b.rows) items.push({ type: "row", row });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, groupBy, stageMap]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flatItems[i].type === "group" ? GROUP_H : ROW_H),
    overscan: 12,
  });

  const totalWidth = table.getTotalSize();
  const virtualRows = virtualizer.getVirtualItems();

  if (leads.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-border/50 text-sm text-muted-foreground">
        No leads match the current filters.
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-xl border border-border bg-card"
        data-testid="leads-table"
      >
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          {/* Header */}
          <div
            className="sticky top-0 z-10 flex border-b bg-card text-muted-foreground"
          >
            {table.getHeaderGroups().map((hg) =>
              hg.headers.map((header) => {
                const col = header.column;
                const canSort = col.getCanSort();
                const sortDir = col.getIsSorted();
                return (
                  <div
                    key={header.id}
                    className="group relative flex items-center px-3 py-2.5 text-xs font-semibold uppercase tracking-wide"
                    style={{ width: header.getSize(), ...pinStyle(col) }}
                  >
                    <div
                      className={`flex items-center gap-1 ${canSort ? "cursor-pointer select-none" : ""}`}
                      onClick={canSort ? col.getToggleSortingHandler() : undefined}
                      data-testid={`th-${col.id}`}
                    >
                      {flexRender(col.columnDef.header, header.getContext())}
                      {canSort &&
                        (sortDir === "asc" ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : sortDir === "desc" ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        ))}
                    </div>
                    {col.id !== "select" && col.id !== "actions" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          col.pin(col.getIsPinned() === "left" ? false : "left");
                        }}
                        className="ml-1 opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
                        aria-label="Pin column"
                      >
                        {col.getIsPinned() === "left" ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                      </button>
                    )}
                    {col.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none bg-transparent hover:bg-muted/60"
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Body */}
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualRows.map((vi) => {
              const item = flatItems[vi.index];
              if (item.type === "group") {
                return (
                  <div
                    key={`g-${item.key}`}
                    className="absolute left-0 flex items-center border-b bg-muted/40"
                    style={{
                      top: 0,
                      transform: `translateY(${vi.start}px)`,
                      height: GROUP_H,
                      width: totalWidth,
                      minWidth: "100%",
                    }}
                  >
                    <div className="sticky left-0 flex items-center gap-2 px-4">
                      <span className="text-sm font-semibold text-foreground">
                        <span>{item.label}</span>
                      </span>
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                        {item.count}
                      </span>
                      <span className="text-xs font-medium text-primary">
                        {formatMoney(item.value, undefined, { compact: true })}
                      </span>
                    </div>
                  </div>
                );
              }
              const row = item.row;
              return (
                <div
                  key={row.id}
                  className="group absolute left-0 flex border-b border-border/60 hover:bg-muted/40"
                  style={{
                    top: 0,
                    transform: `translateY(${vi.start}px)`,
                    height: ROW_H,
                    width: totalWidth,
                    minWidth: "100%",
                  }}
                  onClick={() => props.onOpenLead(row.original.id)}
                  data-testid={`row-lead-${row.original.id}`}
                >
                  {row.getVisibleCells().map((cell) => {
                    const isPinned = cell.column.getIsPinned();
                    return (
                      <div
                        key={cell.id}
                        className={`flex items-center overflow-hidden px-3 ${isPinned ? "bg-card group-hover:bg-muted/40" : ""}`}
                        style={{ width: cell.column.getSize(), ...pinStyle(cell.column) }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <AlertDialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this lead?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? displayName(pendingDelete) : ""} will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
