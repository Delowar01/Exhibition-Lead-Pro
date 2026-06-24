import React from "react";
import { format, parseISO } from "date-fns";
import { useListAuditLogs, type AuditLogEntry } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, FileText } from "lucide-react";

const PAGE_SIZE = 25;

function fmt(s?: string | null) {
  if (!s) return "—";
  try {
    return format(parseISO(s), "MMM d, yyyy HH:mm:ss");
  } catch {
    return s;
  }
}

type Filters = {
  q: string;
  action: string;
  entityType: string;
  startDate: string;
  endDate: string;
};

const EMPTY: Filters = { q: "", action: "", entityType: "", startDate: "", endDate: "" };

// Tenant-scoped audit-log browser. Backend (GET /security/audit) applies the tenant
// boundary, so this is safe in both the platform and company-admin portals; the
// `showCompany` flag only controls whether the company column is rendered.
export function AuditLogViewer({ showCompany = false }: { showCompany?: boolean }) {
  const [draft, setDraft] = React.useState<Filters>(EMPTY);
  const [applied, setApplied] = React.useState<Filters>(EMPTY);
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<AuditLogEntry | null>(null);

  const { data, isLoading, isFetching } = useListAuditLogs({
    q: applied.q || undefined,
    action: applied.action || undefined,
    entityType: applied.entityType || undefined,
    startDate: applied.startDate || undefined,
    endDate: applied.endDate || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const applyFilters = () => {
    setPage(1);
    setApplied(draft);
  };
  const clearFilters = () => {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  };

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5 lg:col-span-3">
              <Label htmlFor="audit-q">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="audit-q"
                  className="pl-8"
                  placeholder="User, action, or entity type"
                  value={draft.q}
                  onChange={(e) => set("q", e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyFilters()}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-action">Action</Label>
              <Input id="audit-action" placeholder="e.g. create" value={draft.action} onChange={(e) => set("action", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-entity">Entity Type</Label>
              <Input id="audit-entity" placeholder="e.g. contact" value={draft.entityType} onChange={(e) => set("entityType", e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="audit-from">From</Label>
                <Input id="audit-from" type="date" value={draft.startDate} onChange={(e) => set("startDate", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="audit-to">To</Label>
                <Input id="audit-to" type="date" value={draft.endDate} onChange={(e) => set("endDate", e.target.value)} />
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={applyFilters} size="sm">
              <Search className="mr-2 h-4 w-4" />
              Apply Filters
            </Button>
            <Button onClick={clearFilters} size="sm" variant="ghost">
              Clear
            </Button>
            <span className="ml-auto text-sm text-muted-foreground">
              {isFetching ? "Loading…" : `${total} ${total === 1 ? "entry" : "entries"}`}
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-md border">
        <Table>
          <TableHeader className="bg-secondary/50">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              {showCompany && <TableHead>Company</TableHead>}
              <TableHead>IP</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={showCompany ? 7 : 6} className="py-8 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={showCompany ? 7 : 6} className="py-8 text-center text-muted-foreground">
                  No audit entries match these filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-sm">{fmt(entry.createdAt)}</TableCell>
                  <TableCell className="text-sm">{entry.userName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="capitalize">
                      {entry.action.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.entityType ?? "—"}
                    {entry.entityId ? <span className="text-muted-foreground"> #{entry.entityId}</span> : null}
                  </TableCell>
                  {showCompany && <TableCell className="text-sm">{entry.companyId ?? "—"}</TableCell>}
                  <TableCell className="font-mono text-xs">{entry.ipAddress ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                      <Button variant="ghost" size="sm" onClick={() => setSelected(entry)}>
                        <FileText className="mr-1 h-4 w-4" />
                        View
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Audit Detail</DialogTitle>
          </DialogHeader>
          {selected && <AuditMetadata entry={selected} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Renders metadata, surfacing before/after values when the entry carries them.
function AuditMetadata({ entry }: { entry: AuditLogEntry }) {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const before = meta.old ?? meta.before ?? meta.previous;
  const after = meta.new ?? meta.after ?? meta.changes;
  const hasDiff = before !== undefined || after !== undefined;

  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <div className="text-muted-foreground">When</div>
        <div>{fmt(entry.createdAt)}</div>
        <div className="text-muted-foreground">User</div>
        <div>{entry.userName ?? "—"}</div>
        <div className="text-muted-foreground">Action</div>
        <div className="capitalize">{entry.action.replace(/_/g, " ")}</div>
        <div className="text-muted-foreground">Entity</div>
        <div>
          {entry.entityType ?? "—"}
          {entry.entityId ? ` #${entry.entityId}` : ""}
        </div>
        <div className="text-muted-foreground">IP Address</div>
        <div className="font-mono text-xs">{entry.ipAddress ?? "—"}</div>
      </div>

      {hasDiff ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 font-medium">Before</div>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(before ?? null, null, 2)}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-medium">After</div>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(after ?? null, null, 2)}
            </pre>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-1 font-medium">Metadata</div>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(meta, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
