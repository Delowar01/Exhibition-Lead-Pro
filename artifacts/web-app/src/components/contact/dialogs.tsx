import React, { useEffect, useState } from "react";
import {
  useUpdateContact,
  useCreateFollowUp,
  useCreateTask,
  getGetContactQueryKey,
  ContactStatus,
  type Contact,
  type TaskInputType,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CalendarClock, ListTodo, Pencil } from "lucide-react";

const ORG_NONE = "__none__";

/* ── Edit Contact Sheet ──────────────────────────────────────────────────── */

export function EditContactSheet({
  contact,
  organizations,
  open,
  onOpenChange,
}: {
  contact: Contact;
  organizations: { id: number; name: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    jobTitle: "",
    contactCompany: "",
    email: "",
    mobile: "",
    linkedin: "",
    website: "",
    address: "",
    notes: "",
    status: contact.status as string,
    organizationId: contact.organizationId ? String(contact.organizationId) : ORG_NONE,
  });

  useEffect(() => {
    if (open) {
      setForm({
        firstName: contact.firstName ?? "",
        lastName: contact.lastName ?? "",
        jobTitle: contact.jobTitle ?? "",
        contactCompany: contact.contactCompany ?? "",
        email: contact.email ?? "",
        mobile: contact.mobile ?? "",
        linkedin: contact.linkedin ?? "",
        website: contact.website ?? "",
        address: contact.address ?? "",
        notes: contact.notes ?? "",
        status: contact.status,
        organizationId: contact.organizationId ? String(contact.organizationId) : ORG_NONE,
      });
    }
  }, [open, contact]);

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    updateContact.mutate(
      {
        id: contact.id,
        data: {
          firstName: form.firstName.trim() || null,
          lastName: form.lastName.trim() || null,
          jobTitle: form.jobTitle.trim() || null,
          contactCompany: form.contactCompany.trim() || null,
          email: form.email.trim() || null,
          mobile: form.mobile.trim() || null,
          linkedin: form.linkedin.trim() || null,
          website: form.website.trim() || null,
          address: form.address.trim() || null,
          notes: form.notes.trim() || null,
          status: form.status as ContactStatus,
          organizationId: form.organizationId === ORG_NONE ? null : Number(form.organizationId),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Contact updated" });
          queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contact.id) });
          onOpenChange(false);
        },
        onError: () => toast({ title: "Could not update contact", variant: "destructive" }),
      },
    );
  };

  const field = (label: string, key: keyof typeof form, type = "text") => (
    <div className="space-y-1.5">
      <Label htmlFor={`edit-${key}`}>{label}</Label>
      <Input
        id={`edit-${key}`}
        type={type}
        value={form[key]}
        onChange={(e) => set(key)(e.target.value)}
        data-testid={`input-edit-${key}`}
      />
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-primary" /> Edit contact
          </SheetTitle>
          <SheetDescription>Update this contact's CRM record.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-5">
          <div className="grid grid-cols-2 gap-3">
            {field("First name", "firstName")}
            {field("Last name", "lastName")}
          </div>
          {field("Job title", "jobTitle")}
          {field("Company name", "contactCompany")}
          <div className="space-y-1.5">
            <Label>Linked company (CRM)</Label>
            <Select value={form.organizationId} onValueChange={set("organizationId")}>
              <SelectTrigger data-testid="select-edit-organization">
                <SelectValue placeholder="Link to a company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ORG_NONE}>None</SelectItem>
                {organizations.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Pipeline status</Label>
            <Select value={form.status} onValueChange={set("status")}>
              <SelectTrigger data-testid="select-edit-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(ContactStatus).map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("Email", "email", "email")}
            {field("Mobile", "mobile", "tel")}
          </div>
          {field("LinkedIn", "linkedin")}
          {field("Website", "website")}
          {field("Address", "address")}
          <div className="space-y-1.5">
            <Label htmlFor="edit-notes">Notes</Label>
            <Textarea
              id="edit-notes"
              rows={4}
              value={form.notes}
              onChange={(e) => set("notes")(e.target.value)}
              data-testid="input-edit-notes"
            />
          </div>
        </div>
        <SheetFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={updateContact.isPending} data-testid="button-save-contact">
            {updateContact.isPending ? "Saving…" : "Save changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/* ── Schedule Follow-up Dialog ───────────────────────────────────────────── */

export function ScheduleFollowUpDialog({
  contactId,
  open,
  onOpenChange,
  onCreated,
}: {
  contactId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}) {
  const { toast } = useToast();
  const createFollowUp = useCreateFollowUp();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setDate("");
      setTime("");
      setNotes("");
    }
  }, [open]);

  const save = () => {
    if (!date) {
      toast({ title: "Pick a date for the follow-up", variant: "destructive" });
      return;
    }
    createFollowUp.mutate(
      {
        data: {
          contactId,
          scheduledDate: date,
          scheduledTime: time || null,
          notes: notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Follow-up scheduled" });
          onOpenChange(false);
          onCreated?.();
        },
        onError: () => toast({ title: "Could not schedule follow-up", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" /> Schedule follow-up
          </DialogTitle>
          <DialogDescription>Plan the next touchpoint with this contact.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fu-date">Date</Label>
              <Input
                id="fu-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="input-followup-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fu-time">Time (optional)</Label>
              <Input
                id="fu-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                data-testid="input-followup-time"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fu-notes">Notes (optional)</Label>
            <Textarea
              id="fu-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What should happen on this follow-up?"
              data-testid="input-followup-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createFollowUp.isPending} data-testid="button-save-followup">
            {createFollowUp.isPending ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Create Task Dialog ──────────────────────────────────────────────────── */

const TASK_TYPES: { value: TaskInputType | string; label: string }[] = [
  { value: "call", label: "Phone Call" },
  { value: "follow_up", label: "Follow-up" },
  { value: "meeting", label: "Meeting" },
  { value: "proposal", label: "Proposal" },
  { value: "custom", label: "Custom Task" },
];

export function CreateTaskDialog({
  contactId,
  open,
  onOpenChange,
  onCreated,
  defaultTitle,
}: {
  contactId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
  defaultTitle?: string;
}) {
  const { toast } = useToast();
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("custom");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle ?? "");
      setType("custom");
      setDueDate("");
      setDueTime("");
      setNotes("");
    }
  }, [open, defaultTitle]);

  const save = () => {
    if (!title.trim()) {
      toast({ title: "Task title is required", variant: "destructive" });
      return;
    }
    createTask.mutate(
      {
        data: {
          title: title.trim(),
          type: type as TaskInputType,
          contactId,
          dueDate: dueDate || null,
          dueTime: dueTime || null,
          notes: notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Task created" });
          onOpenChange(false);
          onCreated?.();
        },
        onError: () => toast({ title: "Could not create task", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-primary" /> Create task
          </DialogTitle>
          <DialogDescription>Plan work for this contact.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Send pricing proposal"
              data-testid="input-task-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger data-testid="select-task-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="input-task-due"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-time">Due time</Label>
              <Input
                id="task-time"
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                data-testid="input-task-time"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-notes">Notes (optional)</Label>
            <Textarea
              id="task-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-task-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createTask.isPending} data-testid="button-save-task">
            {createTask.isPending ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Delete Contact Confirm ──────────────────────────────────────────────── */

export function DeleteContactDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
  contactName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
  contactName: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {contactName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the contact from your CRM. This action cannot be undone from this screen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="button-confirm-delete"
          >
            {pending ? "Deleting…" : "Delete contact"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
