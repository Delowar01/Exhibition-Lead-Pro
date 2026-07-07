import React, { useState } from "react";
import { format, parseISO } from "date-fns";
import {
  useListLeadActivities,
  useCreateLeadActivity,
  useUpdateLeadActivity,
  useDeleteLeadActivity,
  getListLeadActivitiesQueryKey,
  LeadActivityInputType,
  type LeadActivity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ACTIVITY_TYPES = Object.values(LeadActivityInputType);

function fmtDateTime(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy h:mm a");
  } catch {
    return s;
  }
}

export function LeadActivitiesTab({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListLeadActivities(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadActivitiesQueryKey(leadId) },
  });
  const createActivity = useCreateLeadActivity();
  const updateActivity = useUpdateLeadActivity();
  const deleteActivity = useDeleteLeadActivity();

  const emptyForm = {
    type: "call" as (typeof ACTIVITY_TYPES)[number],
    subject: "",
    body: "",
    outcome: "",
    occurredAt: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<LeadActivity | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });

  const activities = [...(data?.activities ?? [])].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );

  const buildPayload = (f: typeof emptyForm) => ({
    type: f.type,
    subject: f.subject.trim() || null,
    body: f.body.trim() || null,
    outcome: f.outcome.trim() || null,
    occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : null,
  });

  const handleCreate = () => {
    createActivity.mutate(
      { id: leadId, data: buildPayload(form) },
      {
        onSuccess: () => {
          setForm(emptyForm);
          invalidate();
          toast({ title: "Activity logged" });
        },
        onError: () => toast({ title: "Could not log activity", variant: "destructive" }),
      }
    );
  };

  const handleSaveEdit = () => {
    if (!editing) return;
    updateActivity.mutate(
      { id: editing.id, data: buildPayload(form) },
      {
        onSuccess: () => {
          setEditing(null);
          setForm(emptyForm);
          invalidate();
          toast({ title: "Activity updated" });
        },
        onError: () => toast({ title: "Could not update activity", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (activity: LeadActivity) => {
    deleteActivity.mutate(
      { id: activity.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Activity deleted" });
        },
        onError: () => toast({ title: "Could not delete activity", variant: "destructive" }),
      }
    );
  };

  const openEdit = (activity: LeadActivity) => {
    setEditing(activity);
    setForm({
      type: (ACTIVITY_TYPES.includes(activity.type as any)
        ? (activity.type as (typeof ACTIVITY_TYPES)[number])
        : "other"),
      subject: activity.subject ?? "",
      body: activity.body ?? "",
      outcome: activity.outcome ?? "",
      occurredAt: activity.occurredAt
        ? format(parseISO(activity.occurredAt), "yyyy-MM-dd'T'HH:mm")
        : "",
    });
  };

  const FormFields = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Type</Label>
          <Select
            value={form.type}
            onValueChange={(v) => setForm({ ...form, type: v as (typeof ACTIVITY_TYPES)[number] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Date &amp; Time</Label>
          <Input
            type="datetime-local"
            value={form.occurredAt}
            onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">Subject</Label>
        <Input
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          placeholder="Subject"
        />
      </div>
      <div>
        <Label className="text-xs">Details</Label>
        <Textarea
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={2}
          placeholder="Details"
        />
      </div>
      <div>
        <Label className="text-xs">Outcome</Label>
        <Input
          value={form.outcome}
          onChange={(e) => setForm({ ...form, outcome: e.target.value })}
          placeholder="Outcome"
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Log Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {FormFields}
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={createActivity.isPending}>
              <Plus className="h-4 w-4 mr-1" /> Log Activity
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading activities...</p>
      ) : activities.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            No activities logged yet.
          </CardContent>
        </Card>
      ) : (
        activities.map((activity) => (
          <Card key={activity.id}>
            <CardContent className="p-4">
              <div className="flex justify-between items-start gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize text-xs">
                      {activity.type}
                    </Badge>
                    {activity.subject && (
                      <span className="text-sm font-medium">{activity.subject}</span>
                    )}
                  </div>
                  {activity.body && (
                    <p className="text-sm mt-2 whitespace-pre-wrap">{activity.body}</p>
                  )}
                  {activity.outcome && (
                    <p className="text-xs mt-2">
                      <span className="text-muted-foreground">Outcome: </span>
                      {activity.outcome}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {activity.userName ? `${activity.userName} • ` : ""}
                    {fmtDateTime(activity.occurredAt)}
                  </p>
                </div>
                {activity.source !== "system" && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(activity)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(activity)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setForm(emptyForm);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Activity</DialogTitle>
          </DialogHeader>
          {FormFields}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setForm(emptyForm);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
