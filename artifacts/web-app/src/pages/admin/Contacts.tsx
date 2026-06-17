import React, { useState } from "react";
import { useListContacts, getListContactsQueryKey, ContactStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { Search, UserPlus, FileText, Mail, Phone, Calendar as CalendarIcon, Contact, Flame, Snowflake, Thermometer } from "lucide-react";
import { Link } from "wouter";

const TEMPERATURE_STYLES: Record<string, { label: string; badge: string; icon: React.ReactNode }> = {
  hot: { label: "Hot", badge: "bg-red-100 text-red-700 border-red-200", icon: <Flame className="h-3 w-3" /> },
  warm: { label: "Warm", badge: "bg-amber-100 text-amber-700 border-amber-200", icon: <Thermometer className="h-3 w-3" /> },
  cold: { label: "Cold", badge: "bg-blue-100 text-blue-700 border-blue-200", icon: <Snowflake className="h-3 w-3" /> },
};

export default function AdminContacts() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading } = useListContacts({
    search: search || undefined,
    status: status !== "all" ? status : undefined,
    limit: 50,
  });

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "new": return "default";
      case "qualified": return "secondary";
      case "won": return "outline";
      case "lost": return "destructive";
      default: return "secondary";
    }
  };

  const formatStatus = (status: string) => {
    return status.replace("_", " ");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Contacts</h1>
        <Link href="/admin/contacts/new" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
          <UserPlus className="mr-2 h-4 w-4" />
          Add Contact
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <div className="relative w-full md:w-80">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search name, company, email..." 
                className="pl-8" 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {Object.values(ContactStatus).map(s => (
                    <SelectItem key={s} value={s} className="capitalize">{formatStatus(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader className="bg-secondary/50">
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Company & Title</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading contacts...</TableCell>
                  </TableRow>
                ) : data?.contacts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12">
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <Contact className="h-12 w-12 mb-4 opacity-20" />
                        <p>No contacts found.</p>
                        <p className="text-sm">Try adjusting your filters or add a new contact.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.contacts.map((contact) => (
                    <TableRow key={contact.id} className="hover:bg-muted/50 cursor-pointer group">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                            {contact.firstName?.charAt(0)}{contact.lastName?.charAt(0)}
                          </div>
                          <div>
                            <div className="font-medium">{contact.firstName} {contact.lastName}</div>
                            <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                              {contact.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {contact.email}</span>}
                              {contact.mobile && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {contact.mobile}</span>}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{contact.contactCompany || "-"}</div>
                        <div className="text-xs text-muted-foreground">{contact.jobTitle || "-"}</div>
                      </TableCell>
                      <TableCell>
                        {contact.leadScore != null ? (
                          <div className="flex items-center gap-2">
                            {contact.leadTemperature && TEMPERATURE_STYLES[contact.leadTemperature] && (
                              <Badge variant="outline" className={`gap-1 ${TEMPERATURE_STYLES[contact.leadTemperature].badge}`}>
                                {TEMPERATURE_STYLES[contact.leadTemperature].icon}
                                {TEMPERATURE_STYLES[contact.leadTemperature].label}
                              </Badge>
                            )}
                            <span className="text-sm font-semibold tabular-nums">{contact.leadScore}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(contact.status) as any} className="capitalize">
                          {formatStatus(contact.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {contact.eventName ? (
                          <div className="flex items-center gap-1 text-sm">
                            <CalendarIcon className="w-3 h-3 text-muted-foreground" />
                            {contact.eventName}
                          </div>
                        ) : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(contact.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/admin/contacts/${contact.id}`} className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-9 px-3 opacity-0 group-hover:opacity-100">
                          View
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
