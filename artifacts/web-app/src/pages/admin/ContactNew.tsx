import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateContact, useListCrmOrganizations, ContactStatus, ApiError } from "@workspace/api-client-react";
import type { ContactInput, ExistingContactFound } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft } from "lucide-react";
import { ExistingContactDialog } from "@/components/ExistingContactDialog";

const contactSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  mobile: z.string().optional(),
  jobTitle: z.string().optional(),
  contactCompany: z.string().optional(),
  organizationId: z.string().optional(),
  status: z.nativeEnum(ContactStatus),
  notes: z.string().optional(),
});

const NONE = "__none__";

type ContactForm = z.infer<typeof contactSchema>;

export default function AdminContactNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createContact = useCreateContact();
  const { data: orgData } = useListCrmOrganizations({ status: "active", limit: 200 });
  const organizations = orgData?.organizations ?? [];

  const form = useForm<ContactForm>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      mobile: "",
      jobTitle: "",
      contactCompany: "",
      organizationId: NONE,
      status: ContactStatus.new,
      notes: "",
    },
  });

  const [pendingPayload, setPendingPayload] = useState<ContactInput | null>(null);
  const [existingContact, setExistingContact] = useState<ExistingContactFound | null>(null);
  const [dedupeDialogOpen, setDedupeDialogOpen] = useState(false);

  const submitPayload = (
    payload: ContactInput,
    opts?: { onSuccessSeparate?: boolean }
  ) => {
    createContact.mutate({ data: payload }, {
      onSuccess: (res) => {
        setDedupeDialogOpen(false);
        toast({
          title: opts?.onSuccessSeparate
            ? "Interaction added"
            : "Contact created successfully",
        });
        setLocation(`/admin/contacts/${res.id}`);
      },
      onError: (err) => {
        if (
          !payload.dedupeResolution &&
          err instanceof ApiError &&
          err.status === 409 &&
          (err.data as ExistingContactFound | null)?.code === "existing_contact_found"
        ) {
          setExistingContact(err.data as ExistingContactFound);
          setDedupeDialogOpen(true);
          return;
        }
        toast({
          variant: "destructive",
          title: "Failed to create contact",
        });
      }
    });
  };

  const onSubmit = (data: ContactForm) => {
    const { organizationId, ...rest } = data;
    const payload: ContactInput = {
      ...rest,
      organizationId: organizationId && organizationId !== NONE ? Number(organizationId) : null,
    };
    setPendingPayload(payload);
    submitPayload(payload);
  };

  const handleAddInteraction = (matchedContactId: number) => {
    if (!pendingPayload) return;
    submitPayload(
      { ...pendingPayload, dedupeResolution: "add_interaction", matchedContactId },
      { onSuccessSeparate: true }
    );
  };

  const handleCreateSeparate = () => {
    if (!pendingPayload) return;
    submitPayload({ ...pendingPayload, dedupeResolution: "create_separate" });
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/admin/contacts")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">New Contact</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name <span className="text-destructive">*</span></Label>
                <Input id="firstName" {...form.register("firstName")} />
                {form.formState.errors.firstName && <p className="text-xs text-destructive">{form.formState.errors.firstName.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input id="lastName" {...form.register("lastName")} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" {...form.register("email")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mobile">Mobile</Label>
                <Input id="mobile" {...form.register("mobile")} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="jobTitle">Job Title</Label>
                <Input id="jobTitle" {...form.register("jobTitle")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactCompany">Company (label)</Label>
                <Input id="contactCompany" {...form.register("contactCompany")} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Company (CRM record)</Label>
              <Select
                onValueChange={(val) => form.setValue("organizationId", val)}
                defaultValue={form.getValues("organizationId")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Link to a company" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {organizations.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Status</Label>
              <Select 
                onValueChange={(val) => form.setValue("status", val as ContactStatus)} 
                defaultValue={form.getValues("status")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(ContactStatus).map(s => (
                    <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={4} {...form.register("notes")} />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button type="button" variant="outline" onClick={() => setLocation("/admin/contacts")}>Cancel</Button>
              <Button type="submit" disabled={createContact.isPending}>
                {createContact.isPending ? "Saving..." : "Save Contact"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <ExistingContactDialog
        data={existingContact}
        open={dedupeDialogOpen}
        onOpenChange={setDedupeDialogOpen}
        submitting={createContact.isPending}
        onAddInteraction={handleAddInteraction}
        onCreateSeparate={handleCreateSeparate}
        onReview={(cid) => setLocation(`/admin/contacts/${cid}`)}
      />
    </div>
  );
}
