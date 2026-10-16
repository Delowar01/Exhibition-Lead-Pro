import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBulkAssignContactsEvent,
  useListEvents,
  getListEventsQueryKey,
  getListContactsQueryKey,
  getGetContactQueryKey,
  getGetContactTimelineQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

// MOBILE-R2 — later event assignment on the admin web: one contact (detail page) or
// many (directory multi-select). "No Event" clears the event. The server scopes the
// contacts and the event to the tenant, enforces the contacts:edit permission and
// records one audit entry per changed contact ("No Event → LEAP 2026").
const NONE = "__none__";

export interface AssignEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactIds: number[];
  /** Current event of the single contact (preselects the option); undefined for a mixed selection. */
  currentEventId?: number | null;
  onDone?: (result: { updated: number; eventName: string | null }) => void;
}

export function AssignEventDialog({ open, onOpenChange, contactIds, currentEventId, onDone }: AssignEventDialogProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const eventsParams = { limit: 200 };
  const { data: eventsData, isLoading } = useListEvents(eventsParams, { query: { enabled: open, queryKey: getListEventsQueryKey(eventsParams) } });
  const assign = useBulkAssignContactsEvent();
  const [value, setValue] = useState<string>(NONE);

  useEffect(() => {
    if (open) setValue(currentEventId != null ? String(currentEventId) : NONE);
  }, [open, currentEventId]);

  const events = eventsData?.events ?? [];
  const count = contactIds.length;
  const changeLabel = currentEventId != null ? "Change Event" : "Assign to Event";

  const submit = async () => {
    if (count === 0) return;
    const eventId = value === NONE ? null : Number(value);
    try {
      const r = await assign.mutateAsync({ data: { contactIds, eventId } });
      await Promise.all([
        qc.invalidateQueries({ queryKey: getListContactsQueryKey() }),
        ...contactIds.flatMap((id) => [
          qc.invalidateQueries({ queryKey: getGetContactQueryKey(id) }),
          qc.invalidateQueries({ queryKey: getGetContactTimelineQueryKey(id) }),
        ]),
      ]);
      toast({
        title: "Event updated",
        description: `${r.updated} contact${r.updated === 1 ? "" : "s"} ${eventId === null ? "removed from their event" : `assigned to ${r.eventName ?? "the event"}`}${r.unchanged ? ` (${r.unchanged} unchanged)` : ""}.`,
      });
      onDone?.({ updated: r.updated, eventName: r.eventName ?? null });
      onOpenChange(false);
    } catch {
      toast({ variant: "destructive", title: "Could not change the event", description: "Check the event and your permissions, then try again." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-assign-event">
        <DialogHeader>
          <DialogTitle>{count > 1 ? `Assign ${count} contacts to an event` : changeLabel}</DialogTitle>
          <DialogDescription>
            Choose the event these contacts were met at, or pick "No Event" to remove it. The change is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <Select value={value} onValueChange={setValue} disabled={isLoading || assign.isPending}>
          <SelectTrigger aria-label="Event" data-testid="select-assign-event">
            <SelectValue placeholder={isLoading ? "Loading events…" : "Select an event"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No Event</SelectItem>
            {events.map((ev) => (
              <SelectItem key={ev.id} value={String(ev.id)}>
                {ev.name}
                {ev.venue ? ` · ${ev.venue}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={assign.isPending || count === 0} data-testid="button-assign-event-confirm">
            {assign.isPending ? "Saving…" : value === NONE ? "Remove event" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AssignEventDialog;
