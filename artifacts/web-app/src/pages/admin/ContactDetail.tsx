import React from "react";
import { useParams, useLocation } from "wouter";
import { useGetContact, useUpdateContact, useDeleteContact, getGetContactQueryKey, ContactStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, Mail, Phone, Building2, Briefcase, Calendar as CalendarIcon, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export default function AdminContactDetail() {
  const { id } = useParams();
  const contactId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: contact, isLoading } = useGetContact(contactId, {
    query: { enabled: !!contactId, queryKey: getGetContactQueryKey(contactId) }
  });

  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();

  const handleStatusChange = (newStatus: ContactStatus) => {
    updateContact.mutate({ id: contactId, data: { status: newStatus } }, {
      onSuccess: () => {
        toast({ title: "Status updated" });
        queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });
      }
    });
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this contact?")) {
      deleteContact.mutate({ id: contactId }, {
        onSuccess: () => {
          toast({ title: "Contact deleted" });
          setLocation("/admin/contacts");
        }
      });
    }
  };

  if (isLoading) return <div className="p-8 flex justify-center">Loading contact...</div>;
  if (!contact) return <div className="p-8 flex justify-center">Contact not found</div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation("/admin/contacts")}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{contact.firstName} {contact.lastName}</h1>
            <div className="flex items-center gap-2 text-muted-foreground mt-1 text-sm">
              <Briefcase className="h-4 w-4" /> {contact.jobTitle || "No title"}
              <span>&bull;</span>
              <Building2 className="h-4 w-4" /> {contact.contactCompany || "No company"}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </Button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Contact Details</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-6">
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Mail className="h-4 w-4" /> Email</div>
                <div className="font-medium">{contact.email || "-"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Phone className="h-4 w-4" /> Mobile</div>
                <div className="font-medium">{contact.mobile || "-"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><CalendarIcon className="h-4 w-4" /> Date Added</div>
                <div className="font-medium">{format(new Date(contact.createdAt), 'PPP')}</div>
              </div>
              {contact.eventName && (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground">Source Event</div>
                  <div className="font-medium">
                    <Badge variant="secondary">{contact.eventName}</Badge>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle>Notes</CardTitle>
                <Button variant="outline" size="sm">Edit</Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="bg-secondary/30 p-4 rounded-md text-sm min-h-[100px] border border-border">
                {contact.notes ? contact.notes : <span className="text-muted-foreground italic">No notes added.</span>}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3 bg-secondary/20">
              <CardTitle>Pipeline Status</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-muted-foreground">Current Stage</div>
                  <Select 
                    value={contact.status} 
                    onValueChange={(val) => handleStatusChange(val as ContactStatus)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(ContactStatus).map(s => (
                        <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {contact.cardImageUrl && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Scanned Card</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="aspect-[4/3] bg-muted rounded-md border flex items-center justify-center overflow-hidden">
                  <img src={contact.cardImageUrl} alt="Business Card" className="object-contain w-full h-full" />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
