import React, { useState } from "react";
import { useListExportRuns, getExportRunDownloadUrl } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import { FileDown, Lock, History } from "lucide-react";
import { humanFileSize, triggerDownload } from "./export-shared";

// Export History — a paginated view over GET /exports/runs. Downloads always
// go through GET /exports/runs/:id/download for a fresh signed URL (the
// frontend never constructs storage URLs). Failed runs show a generic state:
// run.error can contain provider internals, so it is deliberately not shown.

const PAGE_SIZE = 20;

export function ExportHistoryPanel() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useListExportRuns({ page, limit: PAGE_SIZE });

  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDownload = async (runId: number) => {
    try {
      const res = await getExportRunDownloadUrl(runId);
      if (res.url) triggerDownload(res.url);
      else toast({ title: "Download unavailable", variant: "destructive" });
    } catch {
      toast({ title: "Could not get a download link", variant: "destructive" });
    }
  };

  return (
    <Card data-testid="export-history-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Export History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Could not load export history.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : runs.length === 0 ? (
          <div className="py-12 flex flex-col items-center text-center gap-2">
            <History className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No exports yet</p>
            <p className="text-xs text-muted-foreground">
              Files you generate in the Export Center or via schedules appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Protected</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Download</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id} data-testid={`export-run-${r.id}`}>
                      <TableCell className="font-medium max-w-[260px] truncate">{r.fileName ?? "—"}</TableCell>
                      <TableCell className="capitalize">{r.entityType}s</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="uppercase">{r.format}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{(r.rowCount ?? 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{humanFileSize(r.fileSize)}</TableCell>
                      <TableCell>
                        {r.passwordProtected ? (
                          <span className="inline-flex items-center gap-1 text-xs"><Lock className="h-3 w-3" /> Yes</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">No</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.status === "completed" ? (
                          <Badge variant="secondary">Completed</Badge>
                        ) : (
                          <Badge variant="destructive" title="The file could not be generated or stored.">Failed</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(parseISO(r.createdAt), "MMM d, yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.status === "completed" ? (
                          <Button variant="ghost" size="icon" onClick={() => handleDownload(r.id)} title="Download" data-testid={`download-run-${r.id}`}>
                            <FileDown className="h-4 w-4" />
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground pr-2">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {total.toLocaleString()} export{total === 1 ? "" : "s"} · page {page} of {pageCount}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
