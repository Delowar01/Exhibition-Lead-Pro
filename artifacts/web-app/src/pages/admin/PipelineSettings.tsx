import React, { useState } from "react";
import {
  useListPipelineStages,
  useCreatePipelineStage,
  useUpdatePipelineStage,
  useDeletePipelineStage,
  useReorderPipelineStages,
  getListPipelineStagesQueryKey,
  type PipelineStageConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, GripVertical } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const emptyForm = { name: "", color: "#6366f1", isWon: false, isLost: false };

export default function AdminPipelineSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListPipelineStages();
  const createStage = useCreatePipelineStage();
  const updateStage = useUpdatePipelineStage();
  const deleteStage = useDeletePipelineStage();
  const reorderStages = useReorderPipelineStages();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PipelineStageConfig | null>(null);
  const [form, setForm] = useState(emptyForm);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPipelineStagesQueryKey() });

  const stages = [...(data?.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (stage: PipelineStageConfig) => {
    setEditing(stage);
    setForm({
      name: stage.name,
      color: stage.color || "#6366f1",
      isWon: stage.isWon,
      isLost: stage.isLost,
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    if (editing) {
      updateStage.mutate(
        {
          id: editing.id,
          data: {
            name: form.name.trim(),
            color: form.color,
            isWon: form.isWon,
            isLost: form.isLost,
          },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            invalidate();
            toast({ title: "Stage updated" });
          },
          onError: () => toast({ title: "Could not update stage", variant: "destructive" }),
        }
      );
    } else {
      createStage.mutate(
        {
          data: {
            name: form.name.trim(),
            color: form.color,
            isWon: form.isWon,
            isLost: form.isLost,
            sortOrder: stages.length,
          },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            invalidate();
            toast({ title: "Stage created" });
          },
          onError: () => toast({ title: "Could not create stage", variant: "destructive" }),
        }
      );
    }
  };

  const handleDelete = (stage: PipelineStageConfig) => {
    deleteStage.mutate(
      { id: stage.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Stage deleted" });
        },
        onError: () => toast({ title: "Could not delete stage", variant: "destructive" }),
      }
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    const reordered = [...stages];
    const [item] = reordered.splice(index, 1);
    reordered.splice(target, 0, item);
    const order = reordered.map((s, i) => ({ id: s.id, sortOrder: i }));
    reorderStages.mutate(
      { data: { order } },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not reorder", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pipeline Settings</h1>
          <p className="text-muted-foreground mt-1">
            Configure the stages leads move through in your sales pipeline.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> Add Stage
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Stages</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading stages...</p>
          ) : stages.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No stages configured yet.
            </p>
          ) : (
            <div className="space-y-2">
              {stages.map((stage, index) => (
                <div
                  key={stage.id}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card"
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground/40 flex-shrink-0" />
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: stage.color || "#94a3b8" }}
                  />
                  <span className="font-medium text-sm flex-1">{stage.name}</span>
                  {stage.isWon && (
                    <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-none">
                      Won
                    </Badge>
                  )}
                  {stage.isLost && (
                    <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100 border-none">
                      Lost
                    </Badge>
                  )}
                  {(stage.leadCount ?? null) !== null && (
                    <span className="text-xs text-muted-foreground">{stage.leadCount} leads</span>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === stages.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(stage)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(stage)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Stage" : "Add Stage"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Qualified"
              />
            </div>
            <div>
              <Label className="text-xs">Color</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                  className="w-16 h-9 p-1"
                />
                <Input
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Won stage</Label>
              <Switch
                checked={form.isWon}
                onCheckedChange={(v) => setForm({ ...form, isWon: v, isLost: v ? false : form.isLost })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Lost stage</Label>
              <Switch
                checked={form.isLost}
                onCheckedChange={(v) => setForm({ ...form, isLost: v, isWon: v ? false : form.isWon })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!form.name.trim()}>
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
