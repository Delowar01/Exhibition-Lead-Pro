import React from "react";
import { useParams, useLocation } from "wouter";
import { useGetContact, useUpdateContact, useDeleteContact, getGetContactQueryKey, ContactStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, Mail, Phone, Building2, Briefcase, Calendar as CalendarIcon, Trash2, Sparkles, Flame, Snowflake, Thermometer, Globe, Linkedin, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const TEMPERATURE_STYLES: Record<string, { label: string; badge: string; bar: string; icon: React.ReactNode }> = {
  hot: { label: "Hot", badge: "bg-red-100 text-red-700 border-red-200", bar: "bg-red-500", icon: <Flame className="h-4 w-4" /> },
  warm: { label: "Warm", badge: "bg-amber-100 text-amber-700 border-amber-200", bar: "bg-amber-500", icon: <Thermometer className="h-4 w-4" /> },
  cold: { label: "Cold", badge: "bg-blue-100 text-blue-700 border-blue-200", bar: "bg-blue-500", icon: <Snowflake className="h-4 w-4" /> },
};

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

  const temp = contact.leadTemperature ? TEMPERATURE_STYLES[contact.leadTemperature] : null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => setLocation("/admin/contacts")}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight">{contact.firstName} {contact.lastName}</h1>
              {temp && (
                <Badge variant="outline" className={`gap-1 ${temp.badge}`}>
                  {temp.icon} {temp.label}
                </Badge>
              )}
            </div>
            {contact.arabicName && (
              <div className="text-lg text-muted-foreground mt-0.5" dir="rtl">{contact.arabicName}</div>
            )}
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
              {contact.website && (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Globe className="h-4 w-4" /> Website</div>
                  <div className="font-medium break-all">{contact.website}</div>
                </div>
              )}
              {contact.linkedin && (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Linkedin className="h-4 w-4" /> LinkedIn</div>
                  <div className="font-medium break-all">{contact.linkedin}</div>
                </div>
              )}
              {contact.address && (
                <div className="space-y-1 col-span-2">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><MapPin className="h-4 w-4" /> Address</div>
                  <div className="font-medium">{contact.address}</div>
                </div>
              )}
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
              <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Lead Intelligence</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {contact.leadScore != null ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-end justify-between mb-1">
                      <span className="text-sm font-medium text-muted-foreground">Lead Score</span>
                      <span className="text-2xl font-bold leading-none">{contact.leadScore}<span className="text-sm font-normal text-muted-foreground">/100</span></span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                      <div className={`h-full rounded-full ${temp?.bar ?? "bg-primary"}`} style={{ width: `${Math.min(100, Math.max(0, contact.leadScore))}%` }} />
                    </div>
                  </div>
                  {temp && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-muted-foreground">Temperature</span>
                      <Badge variant="outline" className={`gap-1 ${temp.badge}`}>{temp.icon} {temp.label}</Badge>
                    </div>
                  )}
                  {contact.aiReasoning && (
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">AI Reasoning</span>
                      <p className="text-sm bg-secondary/30 p-3 rounded-md border border-border">{contact.aiReasoning}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic py-2">No AI score available for this contact.</div>
              )}
            </CardContent>
          </Card>

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
