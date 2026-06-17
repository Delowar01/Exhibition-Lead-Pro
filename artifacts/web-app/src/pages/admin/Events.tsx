import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useListEvents } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarIcon, MapPin, Users, Target, DollarSign, TrendingUp, Filter } from "lucide-react";
import { format, isPast, isFuture } from "date-fns";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function AdminEvents() {
  const [filter, setFilter] = useState("all");
  const { data, isLoading } = useListEvents({ limit: 50 });

  const events = data?.events || [];
  
  const filteredEvents = events.filter(event => {
    if (filter === "all") return true;
    if (!event.startDate) return true;
    const date = new Date(event.startDate);
    if (filter === "upcoming") return isFuture(date);
    if (filter === "completed") return isPast(date);
    return true;
  });

  // Simulated metrics
  const totalEvents = events.length;
  const totalLeads = events.reduce((acc, ev) => acc + (ev.leadCount || 0), 0);
  const totalOpportunities = Math.floor(totalLeads * 0.4);
  const totalRevenue = totalOpportunities * 5200;
  const avgROI = 320;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Events Management</h1>
        <Button>
          <CalendarIcon className="mr-2 h-4 w-4" />
          Create Event
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Events</CardTitle>
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalEvents}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalLeads.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Opportunities</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalOpportunities.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Est. Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(totalRevenue / 1000).toFixed(1)}k</div>
          </CardContent>
        </Card>
        <Card className="bg-primary text-primary-foreground border-primary-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-primary-foreground/80">Avg. ROI</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">+{avgROI}%</div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border mb-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <CardTitle>All Events</CardTitle>
              <CardDescription>Track performance across all your field events</CardDescription>
            </div>
            <Tabs value={filter} onValueChange={setFilter} className="w-full md:w-auto">
              <TabsList>
                <TabsTrigger value="all">All Events</TabsTrigger>
                <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
                <TabsTrigger value="ongoing">Ongoing</TabsTrigger>
                <TabsTrigger value="completed">Completed</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader className="bg-secondary/50">
                <TableRow>
                  <TableHead>Event Name</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">Loading events...</TableCell>
                  </TableRow>
                ) : filteredEvents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No events found matching criteria.</TableCell>
                  </TableRow>
                ) : (
                  filteredEvents.map((event) => {
                    const leads = event.leadCount || 0;
                    const qualified = Math.floor(leads * 0.4);
                    const isCompleted = event.startDate ? isPast(new Date(event.startDate)) : false;
                    const revenue = qualified * 2500;
                    
                    return (
                      <TableRow key={event.id} className="hover:bg-muted/50 transition-colors cursor-pointer group">
                        <TableCell className="font-medium">
                          {event.name}
                          <div className="text-xs text-muted-foreground font-normal lg:hidden">{event.venue}</div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {event.startDate ? format(new Date(event.startDate), 'MMM d, yyyy') : '-'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
                            <MapPin className="h-3.5 w-3.5" />
                            <span className="truncate max-w-[150px]">{event.venue || '-'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">{leads}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{qualified}</TableCell>
                        <TableCell className="text-right font-medium text-green-600">
                          ${revenue > 0 ? (revenue / 1000).toFixed(1) + 'k' : '0'}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={isCompleted ? "secondary" : "default"} className={isCompleted ? "" : "bg-blue-500 hover:bg-blue-600 text-white"}>
                            {isCompleted ? "Completed" : "Upcoming"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <a href={`/admin/events/${event.id}`}>View Details</a>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
