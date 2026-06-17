import React from "react";
import { useParams, useLocation } from "wouter";
import { useGetEvent, getGetEventQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Calendar as CalendarIcon, MapPin, Users, Briefcase } from "lucide-react";
import { format } from "date-fns";

export default function AdminEventDetail() {
  const { id } = useParams();
  const eventId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();

  const { data: event, isLoading } = useGetEvent(eventId, {
    query: { enabled: !!eventId, queryKey: getGetEventQueryKey(eventId) }
  });

  if (isLoading) return <div className="p-8 flex justify-center">Loading event...</div>;
  if (!event) return <div className="p-8 flex justify-center">Event not found</div>;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/admin/events")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{event.name}</h1>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Event Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><MapPin className="h-4 w-4" /> Venue</div>
                  <div className="font-medium">{event.venue || "-"}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><CalendarIcon className="h-4 w-4" /> Dates</div>
                  <div className="font-medium">
                    {event.startDate ? format(new Date(event.startDate), 'MMM d, yyyy') : '-'} 
                    {event.endDate ? ` - ${format(new Date(event.endDate), 'MMM d, yyyy')}` : ''}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Briefcase className="h-4 w-4" /> Booth Number</div>
                  <div className="font-medium">{event.boothNumber || "-"}</div>
                </div>
              </div>
              <div className="space-y-1 pt-4 border-t">
                <div className="text-sm font-medium text-muted-foreground">Description</div>
                <div className="text-sm">{event.description || "No description provided."}</div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Performance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-muted-foreground">Total Contacts</span>
                <span className="font-bold text-lg">{event.contactCount || 0}</span>
              </div>
              <div className="flex justify-between items-center border-b pb-3">
                <span className="text-muted-foreground">Qualified Leads</span>
                <span className="font-bold text-lg">{event.leadCount || 0}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
