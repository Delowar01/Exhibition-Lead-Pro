import React, { useState } from "react";
import {
  useListExportSchedules,
  useCreateExportSchedule,
  useUpdateExportSchedule,
  useDeleteExportSchedule,
  useRunExportScheduleNow,
  getListExportSchedulesQueryKey,
  getListExportRunsQueryKey,
  type ExportSchedule,
  type ExportScheduleInput,
  type ExportScheduleUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import { CalendarClock, Play, Pencil, Trash2, Plus, Loader2 } from "lucide-react";
import {
  FORMAT_OPTIONS,
  ExportFilterFields,
  cleanFilters,
  type ExportEntity,
  type ExportFileFormat,
  type FilterValues,
} from "./export-shared";

// Recurring export schedules — full CRUD over the existing schedule APIs.
// Scheduled exports are never password-protected (the backend rejects it; a
// stored password would be a plaintext secret), so no password field exists
// here by design. Entity type is fixed after creation (the API does not
// accept changing it on update).

type Frequency = "daily" | "weekly" | "monthly";

interface EditorState {
  mode: "create" | "edit";
  scheduleId?: number;
  name: string;
  entityType: ExportEntity;
  format: ExportFileFormat;
  frequency: Frequency;
  filters: FilterValues;
  active: boolean;
}

const EMPTY_EDITOR: EditorState = {
  mode: "create",
  name: "",
  entityType: "contact",
  format: "csv",
  frequency: "weekly",
  filters: {},
  active: true,
};

function scheduleFilters(s: ExportSchedule): FilterValues {
  const f = s.filters;
  if (!f || typeof f !== "object") return {};
  const out: FilterValues = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (v != null && v !== "") out[k] = String(v);
  }
  return out;
}

export function ExportSchedulesPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useListExportSchedules();
  const createSchedule = useCreateExportSchedule();
  const updateSchedule = useUpdateExportSchedule();
  const deleteSchedule = useDeleteExportSchedule();
  const runNow = useRunExportScheduleNow();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExportSchedule | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);

  const schedules = data?.schedules ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListExportSchedulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListExportRunsQueryKey() });
  };

  const openCreate = () => setEditor({ ...EMPTY_EDITOR });
  const openEdit = (s: ExportSchedule) =>
    setEditor({
      mode: "edit",
      scheduleId: s.id,
      name: s.name,
      entityType: (s.entityType === "lead" ? "lead" : "contact") as ExportEntity,
      format: (FORMAT_OPTIONS.some((o) => o.value === s.format) ? s.format : "csv") as ExportFileFormat,
      frequency: (["daily", "weekly", "monthly"].includes(s.frequency) ? s.frequency : "weekly") as Frequency,
      filters: scheduleFilters(s),
      active: s.active,
    });

  const saveEditor = () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      toast({ title: "Name required", description: "Give this schedule a name.", variant: "destructive" });
      return;
    }
    if (editor.mode === "create") {
      const body: ExportScheduleInput = {
        name: editor.name.trim(),
        entityType: editor.entityType,
        format: editor.format,
        frequency: editor.frequency,
        filters: cleanFilters(editor.filters),
        active: editor.active,
      };
      createSchedule.mutate(
        { data: body },
        {
          onSuccess: () => {
            setEditor(null);
            invalidate();
            toast({ title: "Schedule created" });
          },
          onError: () => toast({ title: "Could not create schedule", variant: "destructive" }),
        },
      );
    } else {
      const body: ExportScheduleUpdate = {
        name: editor.name.trim(),
        format: editor.format,
        frequency: editor.frequency,
        filters: cleanFilters(editor.filters),
        active: editor.active,
      };
      updateSchedule.mutate(
        { id: editor.scheduleId!, data: body },
        {
          onSuccess: () => {
            setEditor(null);
            invalidate();
            toast({ title: "Schedule updated" });
          },
          onError: () => toast({ title: "Could not update schedule", variant: "destructive" }),
        },
      );
    }
  };

  const toggleActive = (s: ExportSchedule) => {
    updateSchedule.mutate(
      { id: s.id, data: { active: !s.active } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: s.active ? "Schedule paused" : "Schedule activated" });
        },
        onError: () => toast({ title: "Could not update schedule", variant: "destructive" }),
      },
    );
  };

  const handleRunNow = (s: ExportSchedule) => {
    setRunningId(s.id);
    runNow.mutate(
      { id: s.id },
      {
        onSuccess: (run) => {
          invalidate();
          if (run.status === "failed") {
            toast({ title: "Run failed", description: "The export could not be generated.", variant: "destructive" });
          } else {
            toast({ title: "Export generated", description: `${run.fileName} · ${(run.rowCount ?? 0).toLocaleString()} rows. Find it in Export History.` });
          }
        },
        onError: () => toast({ title: "Could not run the schedule", variant: "destructive" }),
        onSettled: () => setRunningId(null),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteSchedule.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          invalidate();
          toast({ title: "Schedule deleted" });
        },
        onError: () => toast({ title: "Could not delete schedule", variant: "destructive" }),
      },
    );
  };

  const editorSaving = createSchedule.isPending || updateSchedule.isPending;

  return (
    <div className="space-y-4" data-testid="export-schedules-panel">
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Recurring Export Schedules</CardTitle>
          <Button size="sm" onClick={openCreate} data-testid="schedule-new">
            <Plus className="mr-1.5 h-4 w-4" /> New schedule
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : isError ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm text-muted-foreground">Could not load schedules.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : schedules.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-2">
              <CalendarClock className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">No schedules yet</p>
              <p className="text-xs text-muted-foreground">
                Create a recurring export to generate a fresh file daily, weekly, or monthly.
              </p>
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((s) => (
                    <TableRow key={s.id} data-testid={`schedule-row-${s.id}`}>
                      <TableCell className="font-medium max-w-[220px] truncate">{s.name}</TableCell>
                      <TableCell className="capitalize">{s.entityType}s</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="uppercase">{s.format}</Badge>
                      </TableCell>
                      <TableCell className="capitalize">{s.frequency}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {s.lastRunAt ? format(parseISO(s.lastRunAt), "MMM d, yyyy HH:mm") : "Never"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {s.active ? format(parseISO(s.nextRunAt), "MMM d, yyyy HH:mm") : "Paused"}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={s.active}
                          onCheckedChange={() => toggleActive(s)}
                          disabled={updateSchedule.isPending}
                          aria-label={s.active ? "Deactivate schedule" : "Activate schedule"}
                          data-testid={`schedule-toggle-${s.id}`}
                        />
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Run now"
                          onClick={() => handleRunNow(s)}
                          disabled={runNow.isPending}
                          data-testid={`schedule-run-${s.id}`}
                        >
                          {runningId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" title="Edit" onClick={() => openEdit(s)} data-testid={`schedule-edit-${s.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Delete" onClick={() => setDeleteTarget(s)} data-testid={`schedule-delete-${s.id}`}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "create" ? "New export schedule" : "Edit schedule"}</DialogTitle>
            <DialogDescription>
              Runs automatically and files the result in Export History. Scheduled exports cannot be
              password-protected.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Name</Label>
                  <Input
                    placeholder="e.g. Weekly hot leads"
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    data-testid="schedule-name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Entity</Label>
                  <Select
                    value={editor.entityType}
                    onValueChange={(v) =>
                      setEditor({ ...editor, entityType: v as ExportEntity, filters: {} })
                    }
                    disabled={editor.mode === "edit"}
                  >
                    <SelectTrigger data-testid="schedule-entity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contact">Contacts</SelectItem>
                      <SelectItem value="lead">Leads</SelectItem>
                    </SelectContent>
                  </Select>
                  {editor.mode === "edit" && (
                    <p className="text-[11px] text-muted-foreground">Entity cannot change after creation.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Format</Label>
                  <Select value={editor.format} onValueChange={(v) => setEditor({ ...editor, format: v as ExportFileFormat })}>
                    <SelectTrigger data-testid="schedule-format">
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
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Frequency</Label>
                  <Select value={editor.frequency} onValueChange={(v) => setEditor({ ...editor, frequency: v as Frequency })}>
                    <SelectTrigger data-testid="schedule-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Active</Label>
                  <div className="h-10 flex items-center">
                    <Switch
                      checked={editor.active}
                      onCheckedChange={(v) => setEditor({ ...editor, active: v })}
                      aria-label="Schedule active"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Filters</Label>
                <ExportFilterFields
                  entityType={editor.entityType}
                  value={editor.filters}
                  onChange={(filters) => setEditor({ ...editor, filters })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)} disabled={editorSaving}>
              Cancel
            </Button>
            <Button onClick={saveEditor} disabled={editorSaving} data-testid="schedule-save">
              {editorSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editor?.mode === "create" ? "Create schedule" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” will stop running. Files it already generated stay in Export History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} data-testid="schedule-delete-confirm">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
