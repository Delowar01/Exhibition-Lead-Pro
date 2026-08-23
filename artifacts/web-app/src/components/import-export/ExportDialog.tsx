import React, { useState } from "react";
import {
  useCreateExport,
  useListExportRuns,
  useListExportSchedules,
  useCreateExportSchedule,
  useDeleteExportSchedule,
  useRunExportScheduleNow,
  getExportRunDownloadUrl,
  getListExportRunsQueryKey,
  getListExportSchedulesQueryKey,
  type ExportCreateInput,
  type ExportScheduleInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { format as formatDate, parseISO } from "date-fns";
import { Download, Lock, Trash2, Play, Clock, FileDown, Loader2 } from "lucide-react";
import { EncryptionMethodSelector, type ZipEncryptionMethod } from "@/components/reports/export-shared";

type EntityType = "contact" | "lead";
type ExportFormat = "csv" | "excel" | "pdf" | "json";
type Frequency = "daily" | "weekly" | "monthly";

const FORMAT_OPTIONS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: "csv", label: "CSV", hint: "Comma-separated, opens in any spreadsheet" },
  { value: "excel", label: "Excel", hint: "Native .xlsx workbook" },
  { value: "pdf", label: "PDF", hint: "Printable table document" },
  { value: "json", label: "JSON", hint: "Structured data for developers" },
];

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
  filters: Record<string, string | undefined>;
  /** How many records the current filter selects, for the confirmation copy. */
  filteredCount?: number;
}

export function ExportDialog({ open, onOpenChange, entityType, filters, filteredCount }: ExportDialogProps) {
  const label = entityType === "contact" ? "Contacts" : "Leads";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export {label}</DialogTitle>
          <DialogDescription>
            Download the current filtered {entityType}s, or set up a recurring export.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="now">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="now">Export now</TabsTrigger>
            <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          </TabsList>
          <TabsContent value="now">
            <ExportNowPanel entityType={entityType} filters={filters} filteredCount={filteredCount} />
          </TabsContent>
          <TabsContent value="scheduled">
            <SchedulesPanel entityType={entityType} filters={filters} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function cleanFilters(filters: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v != null && v !== "" && v !== "all") out[k] = v;
  }
  return out;
}

function ExportNowPanel({
  entityType,
  filters,
  filteredCount,
}: {
  entityType: EntityType;
  filters: Record<string, string | undefined>;
  filteredCount?: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createExport = useCreateExport();
  const [fmt, setFmt] = useState<ExportFormat>("csv");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [encMethod, setEncMethod] = useState<ZipEncryptionMethod>("aes256");

  const passwordInvalid = protect && password.length < 6;

  const handleExport = () => {
    if (passwordInvalid) return;
    const body: ExportCreateInput = {
      entityType,
      format: fmt,
      filters: cleanFilters(filters),
      passwordProtected: protect,
      password: protect ? password : null,
      // Transient, only meaningful alongside a password; AES-256 is the default.
      ...(protect ? { encryptionMethod: encMethod } : {}),
    };
    createExport.mutate(
      { data: body },
      {
        onSuccess: (run) => {
          setPassword(""); // never keep the password after completion
          setProtect(false);
          setEncMethod("aes256");
          queryClient.invalidateQueries({ queryKey: getListExportRunsQueryKey() });
          if (run.status === "failed") {
            toast({ title: "Export failed", description: run.error ?? "Could not generate the file.", variant: "destructive" });
            return;
          }
          if (run.downloadUrl) {
            triggerDownload(run.downloadUrl);
            toast({
              title: `Exported ${run.rowCount ?? 0} ${entityType}${run.rowCount === 1 ? "" : "s"}`,
              description: protect ? "Your download is password-protected." : undefined,
            });
          } else {
            toast({ title: "Export ready", description: "No download URL was returned." });
          }
        },
        onError: () => {
          setPassword(""); // never keep the password after failure
          toast({ title: "Export failed", variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-5 py-2">
      <div className="space-y-2">
        <Label>Format</Label>
        <div className="grid grid-cols-2 gap-2">
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFmt(opt.value)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                fmt === opt.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/50"
              }`}
            >
              <div className="font-medium text-sm">{opt.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{opt.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox id="protect" checked={protect} onCheckedChange={(v) => setProtect(v === true)} />
          <Label htmlFor="protect" className="flex items-center gap-1.5 cursor-pointer font-normal">
            <Lock className="h-3.5 w-3.5" /> Password-protect the file
          </Label>
        </div>
        {protect && (
          <div className="pl-6 space-y-3">
            <div className="space-y-1">
              <Input
                type="password"
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The file is delivered as an encrypted ZIP. Keep this password safe — it cannot be recovered.
              </p>
            </div>
            <EncryptionMethodSelector value={encMethod} onChange={setEncMethod} />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {filteredCount != null
            ? `Exports the ${filteredCount} ${entityType}${filteredCount === 1 ? "" : "s"} matching your current filters.`
            : "Exports the records matching your current filters."}
        </p>
        <Button onClick={handleExport} disabled={createExport.isPending || passwordInvalid}>
          {createExport.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {createExport.isPending ? "Generating..." : "Generate & download"}
        </Button>
      </div>
    </div>
  );
}

function SchedulesPanel({
  entityType,
  filters,
}: {
  entityType: EntityType;
  filters: Record<string, string | undefined>;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: schedulesData, isLoading } = useListExportSchedules();
  const { data: runsData } = useListExportRuns();
  const createSchedule = useCreateExportSchedule();
  const deleteSchedule = useDeleteExportSchedule();
  const runNow = useRunExportScheduleNow();

  const [name, setName] = useState("");
  const [fmt, setFmt] = useState<ExportFormat>("csv");
  const [frequency, setFrequency] = useState<Frequency>("weekly");

  const schedules = (schedulesData?.schedules ?? []).filter((s) => s.entityType === entityType);
  const runs = (runsData?.runs ?? []).filter((r) => r.entityType === entityType).slice(0, 5);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListExportSchedulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListExportRunsQueryKey() });
  };

  const handleCreate = () => {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give this schedule a name.", variant: "destructive" });
      return;
    }
    const body: ExportScheduleInput = {
      name: name.trim(),
      entityType,
      format: fmt,
      frequency,
      filters: cleanFilters(filters),
      active: true,
    };
    createSchedule.mutate(
      { data: body },
      {
        onSuccess: () => {
          setName("");
          invalidate();
          toast({ title: "Schedule created" });
        },
        onError: () => toast({ title: "Could not create schedule", variant: "destructive" }),
      },
    );
  };

  const handleRunNow = async (id: number) => {
    runNow.mutate(
      { id },
      {
        onSuccess: (run) => {
          invalidate();
          if (run.status === "failed") {
            toast({ title: "Run failed", description: run.error ?? undefined, variant: "destructive" });
          } else {
            toast({ title: "Export generated", description: `${run.rowCount ?? 0} ${entityType}s.` });
          }
        },
        onError: () => toast({ title: "Could not run schedule", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteSchedule.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Schedule deleted" });
        },
        onError: () => toast({ title: "Could not delete schedule", variant: "destructive" }),
      },
    );
  };

  const handleDownloadRun = async (runId: number) => {
    try {
      const res = await getExportRunDownloadUrl(runId);
      if (res.url) triggerDownload(res.url);
    } catch {
      toast({ title: "Could not get download link", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-5 py-2">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="text-sm font-medium">New schedule</div>
        <p className="text-xs text-muted-foreground -mt-1">
          Uses your current filters. Scheduled exports cannot be password-protected.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input placeholder="Schedule name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={fmt} onValueChange={(v) => setFmt(v as ExportFormat)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMAT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={handleCreate} disabled={createSchedule.isPending}>
            <Clock className="mr-2 h-4 w-4" />
            Create schedule
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Active schedules</div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedules yet.</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border p-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2">
                    <Badge variant="outline" className="uppercase">{s.format}</Badge>
                    <span className="capitalize">{s.frequency}</span>
                    <span>· next {formatDate(parseISO(s.nextRunAt), "MMM d, HH:mm")}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => handleRunNow(s.id)} disabled={runNow.isPending} title="Run now">
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(s.id)} disabled={deleteSchedule.isPending} title="Delete">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {runs.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Recent runs</div>
          <div className="space-y-1.5">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant={r.status === "completed" ? "secondary" : "destructive"}>{r.status}</Badge>
                  <span className="truncate">{r.fileName ?? `${entityType}s export`}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatDate(parseISO(r.createdAt), "MMM d, HH:mm")}
                  </span>
                </div>
                {r.status === "completed" && (
                  <Button variant="ghost" size="icon" onClick={() => handleDownloadRun(r.id)} title="Download">
                    <FileDown className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
