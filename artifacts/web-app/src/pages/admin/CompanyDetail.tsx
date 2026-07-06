import React from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  useGetCrmOrganization,
  useListCrmOrganizationContacts,
  useListCrmOrganizationLeads,
  useListCrmOrganizationEvents,
  useListCrmOrganizationNotes,
  useListCrmOrganizationDocuments,
  useGetCrmOrganizationTimeline,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, Building2, Globe, Phone, Mail, MapPin, Users, Target, DollarSign, Calendar, StickyNote, FileText, Clock } from "lucide-react";
import { AiInsightsPanel } from "@/components/AiInsightsPanel";
import { SalesCopilotPanel } from "@/components/SalesCopilotPanel";
import { WorkflowIntelligencePanel } from "@/components/WorkflowIntelligencePanel";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminCompanyDetail() {
  const [, params] = useRoute("/admin/companies/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);

  const { data: org, isLoading } = useGetCrmOrganization(id);
  const { data: contactsData } = useListCrmOrganizationContacts(id);
  const { data: leadsData } = useListCrmOrganizationLeads(id);
  const { data: eventsData } = useListCrmOrganizationEvents(id);
  const { data: notesData } = useListCrmOrganizationNotes(id);
  const { data: documentsData } = useListCrmOrganizationDocuments(id);
  const { data: timelineData } = useGetCrmOrganizationTimeline(id);
  const contacts = contactsData?.contacts ?? [];
  const leads = leadsData?.leads ?? [];
  const events = eventsData?.events ?? [];
  const notes = notesData?.notes ?? [];
  const documents = documentsData?.documents ?? [];
  const timeline = timelineData?.entries ?? [];

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading company...</div>;
  }
  if (!org) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-muted-foreground">Company not found.</p>
        <Button variant="outline" onClick={() => setLocation("/admin/companies")}>Back to Companies</Button>
      </div>
    );
  }

  const infoRows: { icon: React.ReactNode; label: string; value: string | null | undefined }[] = [
    { icon: <Building2 className="h-4 w-4" />, label: "Industry", value: org.industry },
    { icon: <Globe className="h-4 w-4" />, label: "Website", value: org.website },
    { icon: <Phone className="h-4 w-4" />, label: "Phone", value: org.phone },
    { icon: <Mail className="h-4 w-4" />, label: "Email", value: org.email },
    { icon: <MapPin className="h-4 w-4" />, label: "Address", value: org.address },
    { icon: <MapPin className="h-4 w-4" />, label: "Country", value: org.country },
    { icon: <Users className="h-4 w-4" />, label: "Size", value: org.size },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/admin/companies")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{org.name}</h1>
            <Badge variant={org.status === "active" ? "default" : "secondary"} className="capitalize">{org.status}</Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Users className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">{org.contactCount ?? 0}</div>
              <div className="text-sm text-muted-foreground">Contacts</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Target className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">{org.leadCount ?? 0}</div>
              <div className="text-sm text-muted-foreground">Leads</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <DollarSign className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold tabular-nums">{formatCurrency(org.openLeadValue ?? 0)}</div>
              <div className="text-sm text-muted-foreground">Open Pipeline</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {infoRows.filter((r) => r.value).map((r) => (
                <div key={r.label} className="flex items-start gap-3 text-sm">
                  <span className="text-muted-foreground mt-0.5">{r.icon}</span>
                  <div>
                    <div className="text-xs text-muted-foreground">{r.label}</div>
                    <div>{r.value}</div>
                  </div>
                </div>
              ))}
              {org.notes && (
                <div className="pt-2 border-t">
                  <div className="text-xs text-muted-foreground mb-1">Notes</div>
                  <div className="text-sm whitespace-pre-wrap">{org.notes}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {Number.isFinite(id) && id > 0 && <SalesCopilotPanel entityType="organization" id={id} />}
          {Number.isFinite(id) && id > 0 && <WorkflowIntelligencePanel entityType="organization" id={id} />}
          {Number.isFinite(id) && id > 0 && <AiInsightsPanel entityType="organization" id={id} />}
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Relationships</CardTitle>
            <CardDescription>Contacts, leads, events, notes, documents and activity at this company.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="contacts">
              <TabsList className="flex-wrap h-auto">
                <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
                <TabsTrigger value="leads">Leads ({leads.length})</TabsTrigger>
                <TabsTrigger value="events">Events ({events.length})</TabsTrigger>
                <TabsTrigger value="notes">Notes ({notes.length})</TabsTrigger>
                <TabsTrigger value="documents">Documents ({documents.length})</TabsTrigger>
                <TabsTrigger value="timeline">Timeline ({timeline.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="contacts" className="mt-4">
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-secondary/50">
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Job Title</TableHead>
                        <TableHead>Email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contacts.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No contacts linked.</TableCell></TableRow>
                      ) : (
                        contacts.map((c) => (
                          <TableRow key={c.id} className="hover:bg-muted/50">
                            <TableCell>
                              <Link href={`/admin/contacts/${c.id}`} className="font-medium hover:underline">
                                {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{c.jobTitle ?? "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{c.email ?? "—"}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="leads" className="mt-4">
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-secondary/50">
                      <TableRow>
                        <TableHead>Title</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leads.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No leads linked.</TableCell></TableRow>
                      ) : (
                        leads.map((l) => (
                          <TableRow key={l.id} className="hover:bg-muted/50">
                            <TableCell>
                              <Link href={`/admin/leads/${l.id}`} className="font-medium hover:underline">
                                {l.title ?? `Lead #${l.id}`}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground capitalize">{l.stage ?? "—"}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums">
                              {l.value != null ? `${l.currency ?? ""} ${Number(l.value).toLocaleString()}`.trim() : "—"}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="events" className="mt-4">
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-secondary/50">
                      <TableRow>
                        <TableHead>Event</TableHead>
                        <TableHead>Dates</TableHead>
                        <TableHead className="text-right">Contacts</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {events.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No events linked.</TableCell></TableRow>
                      ) : (
                        events.map((e) => (
                          <TableRow key={e.id} className="hover:bg-muted/50">
                            <TableCell>
                              <Link href={`/admin/events/${e.id}`} className="font-medium hover:underline flex items-center gap-2">
                                <Calendar className="h-4 w-4 text-muted-foreground" />
                                {e.name}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {formatDate(e.startDate)}{e.endDate ? ` – ${formatDate(e.endDate)}` : ""}
                            </TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{e.contactCount ?? 0}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="notes" className="mt-4">
                {notes.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">No notes recorded.</div>
                ) : (
                  <div className="space-y-3">
                    {notes.map((n) => (
                      <div key={n.id} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <StickyNote className="h-4 w-4 text-muted-foreground" />
                            {n.userName ?? "Unknown"}
                            {n.isPinned && <Badge variant="secondary" className="text-xs">Pinned</Badge>}
                          </div>
                          <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                        </div>
                        <div className="text-sm whitespace-pre-wrap">{n.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="documents" className="mt-4">
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-secondary/50">
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Attached To</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {documents.length === 0 ? (
                        <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No documents linked.</TableCell></TableRow>
                      ) : (
                        documents.map((d) => (
                          <TableRow key={d.id} className="hover:bg-muted/50">
                            <TableCell className="font-medium flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              {d.name}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground capitalize">
                              {d.entityType}{d.entityName ? `: ${d.entityName}` : ""}
                            </TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{formatBytes(d.currentVersion?.fileSize)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
              <TabsContent value="timeline" className="mt-4">
                {timeline.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">No activity yet.</div>
                ) : (
                  <div className="space-y-3">
                    {timeline.map((t) => (
                      <div key={t.id} className="flex gap-3">
                        <div className="mt-1 text-muted-foreground">
                          <Clock className="h-4 w-4" />
                        </div>
                        <div className="flex-1 border-b pb-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{t.title ?? (t.kind === "note" ? "Note" : t.type ?? t.kind)}</span>
                            <span className="text-xs text-muted-foreground">{formatDateTime(t.occurredAt)}</span>
                          </div>
                          {t.body && <div className="text-sm text-muted-foreground whitespace-pre-wrap mt-0.5">{t.body}</div>}
                          {t.actorName && <div className="text-xs text-muted-foreground mt-0.5">by {t.actorName}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
