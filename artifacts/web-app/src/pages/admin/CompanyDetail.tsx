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
  getGetCrmOrganizationQueryKey,
  getListCrmOrganizationContactsQueryKey,
  getListCrmOrganizationLeadsQueryKey,
  getListCrmOrganizationEventsQueryKey,
  getListCrmOrganizationNotesQueryKey,
  getListCrmOrganizationDocumentsQueryKey,
  getGetCrmOrganizationTimelineQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  Globe,
  Phone,
  Mail,
  MapPin,
  Users,
  Target,
  DollarSign,
  Calendar,
  StickyNote,
  FileText,
  Clock,
  History,
  CalendarCheck,
  UserCheck,
} from "lucide-react";

import {
  WorkspaceShell,
  WorkspaceHeader,
  WorkspaceContent,
  WorkspaceMain,
  WorkspaceSidebar,
} from "@/components/ds/workspace";
import { AiInsightsPanel } from "@/components/AiInsightsPanel";
import { SalesCopilotPanel } from "@/components/SalesCopilotPanel";
import { WorkflowIntelligencePanel } from "@/components/WorkflowIntelligencePanel";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
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

function InfoRow({ label, icon, value }: { label: string; icon?: React.ReactNode; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 text-sm">
      {icon && <span className="text-muted-foreground mt-0.5">{icon}</span>}
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-medium">{value}</div>
      </div>
    </div>
  );
}

export default function AdminCompanyDetail() {
  const [, params] = useRoute("/admin/companies/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);

  const { data: org, isLoading } = useGetCrmOrganization(id, {
    query: { enabled: !!id, queryKey: getGetCrmOrganizationQueryKey(id) },
  });
  const { data: contactsData } = useListCrmOrganizationContacts(id, {
    query: { enabled: !!id, queryKey: getListCrmOrganizationContactsQueryKey(id) },
  });
  const { data: leadsData } = useListCrmOrganizationLeads(id, {
    query: { enabled: !!id, queryKey: getListCrmOrganizationLeadsQueryKey(id) },
  });
  const { data: eventsData } = useListCrmOrganizationEvents(id, {
    query: { enabled: !!id, queryKey: getListCrmOrganizationEventsQueryKey(id) },
  });
  const { data: notesData } = useListCrmOrganizationNotes(id, {
    query: { enabled: !!id, queryKey: getListCrmOrganizationNotesQueryKey(id) },
  });
  const { data: documentsData } = useListCrmOrganizationDocuments(id, {
    query: { enabled: !!id, queryKey: getListCrmOrganizationDocumentsQueryKey(id) },
  });
  const { data: timelineData } = useGetCrmOrganizationTimeline(id, {
    query: { enabled: !!id, queryKey: getGetCrmOrganizationTimelineQueryKey(id) },
  });

  const contacts = contactsData?.contacts ?? [];
  const leads = leadsData?.leads ?? [];
  const events = eventsData?.events ?? [];
  const notes = notesData?.notes ?? [];
  const documents = documentsData?.documents ?? [];
  const timeline = timelineData?.entries ?? [];

  if (isLoading) {
    return <div className="p-8 flex justify-center text-muted-foreground">Loading company...</div>;
  }
  if (!org) {
    return (
      <div className="p-8 flex flex-col items-center gap-4 text-center">
        <p className="text-muted-foreground">Company not found.</p>
        <Button variant="outline" onClick={() => setLocation("/admin/companies")}>
          Back to Companies
        </Button>
      </div>
    );
  }

  const headerBadges = (
    <>
      <Badge variant={org.status === "active" ? "default" : "secondary"} className="capitalize">
        {org.status}
      </Badge>
    </>
  );

  const headerSubtitle = (
    <>
      {org.industry && (
        <>
          <Building2 className="h-4 w-4" />
          <span>{org.industry}</span>
          <span className="text-border">•</span>
        </>
      )}
      {org.website && (
        <>
          <Globe className="h-4 w-4" />
          <span>{org.website}</span>
        </>
      )}
    </>
  );

  return (
    <WorkspaceShell>
      <WorkspaceHeader
        title={org.name}
        subtitle={headerSubtitle}
        badges={headerBadges}
        onBack={() => setLocation("/admin/companies")}
      />

      <WorkspaceContent>
        <WorkspaceMain>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <Users className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold">{org.contactCount ?? 0}</div>
                  <div className="text-sm text-muted-foreground">Contacts</div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <Target className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold">{org.leadCount ?? 0}</div>
                  <div className="text-sm text-muted-foreground">Leads</div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <DollarSign className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold tabular-nums">
                    {formatCurrency(org.openLeadValue ?? 0)}
                  </div>
                  <div className="text-sm text-muted-foreground">Open Pipeline</div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <History className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold">{org.interactionCount ?? 0}</div>
                  <div className="text-sm text-muted-foreground">Interactions</div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <CalendarCheck className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold">{org.eventsAttended ?? 0}</div>
                  <div className="text-sm text-muted-foreground">Events Attended</div>
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-sm border-border/50">
              <CardContent className="pt-6 flex items-center gap-3">
                <Clock className="h-8 w-8 text-primary/60" />
                <div>
                  <div className="text-2xl font-bold">{formatDate(org.lastInteractionDate)}</div>
                  <div className="text-sm text-muted-foreground">Last Interaction</div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Tabs defaultValue="contacts" className="w-full">
            <TabsList className="w-full justify-start border-b border-border rounded-none h-auto p-0 bg-transparent mb-6 overflow-x-auto flex-nowrap shrink-0">
              <TabsTrigger
                value="contacts"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Contacts ({contacts.length})
              </TabsTrigger>
              <TabsTrigger
                value="leads"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Leads ({leads.length})
              </TabsTrigger>
              <TabsTrigger
                value="events"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Events ({events.length})
              </TabsTrigger>
              <TabsTrigger
                value="notes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Notes ({notes.length})
              </TabsTrigger>
              <TabsTrigger
                value="documents"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Documents ({documents.length})
              </TabsTrigger>
              <TabsTrigger
                value="timeline"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Timeline ({timeline.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="contacts" className="mt-0">
              <div className="rounded-md border bg-card overflow-hidden shadow-sm">
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
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                          No contacts linked.
                        </TableCell>
                      </TableRow>
                    ) : (
                      contacts.map((c) => (
                        <TableRow key={c.id} className="hover:bg-muted/50">
                          <TableCell>
                            <Link href={`/admin/contacts/${c.id}`} className="font-medium hover:underline text-primary">
                              {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                            </Link>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {c.jobTitle ?? "—"}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {c.email ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="leads" className="mt-0">
              <div className="rounded-md border bg-card overflow-hidden shadow-sm">
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
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                          No leads linked.
                        </TableCell>
                      </TableRow>
                    ) : (
                      leads.map((l) => (
                        <TableRow key={l.id} className="hover:bg-muted/50">
                          <TableCell>
                            <Link href={`/admin/leads/${l.id}`} className="font-medium hover:underline text-primary">
                              {l.title ?? `Lead #${l.id}`}
                            </Link>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground capitalize">
                            {l.stage ?? "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums font-medium">
                            {l.value != null
                              ? `${l.currency ?? ""} ${Number(l.value).toLocaleString()}`.trim()
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="events" className="mt-0">
              <div className="rounded-md border bg-card overflow-hidden shadow-sm">
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
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                          No events linked.
                        </TableCell>
                      </TableRow>
                    ) : (
                      events.map((e) => (
                        <TableRow key={e.id} className="hover:bg-muted/50">
                          <TableCell>
                            <Link
                              href={`/admin/events/${e.id}`}
                              className="font-medium hover:underline text-primary flex items-center gap-2"
                            >
                              <Calendar className="h-4 w-4 text-muted-foreground" />
                              {e.name}
                            </Link>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(e.startDate)}
                            {e.endDate ? ` – ${formatDate(e.endDate)}` : ""}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {e.contactCount ?? 0}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="notes" className="mt-0">
              {notes.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm border bg-card rounded-md shadow-sm">
                  No notes recorded.
                </div>
              ) : (
                <div className="space-y-3">
                  {notes.map((n) => (
                    <div key={n.id} className="rounded-md border bg-card shadow-sm p-4">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <StickyNote className="h-4 w-4 text-primary" />
                          {n.userName ?? "Unknown"}
                          {n.isPinned && (
                            <Badge variant="secondary" className="text-xs">
                              Pinned
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(n.createdAt)}
                        </span>
                      </div>
                      <div className="text-sm whitespace-pre-wrap">{n.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="documents" className="mt-0">
              <div className="rounded-md border bg-card overflow-hidden shadow-sm">
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
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                          No documents linked.
                        </TableCell>
                      </TableRow>
                    ) : (
                      documents.map((d) => (
                        <TableRow key={d.id} className="hover:bg-muted/50">
                          <TableCell className="font-medium flex items-center gap-2 text-primary">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            {d.name}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground capitalize">
                            {d.entityType}
                            {d.entityName ? `: ${d.entityName}` : ""}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {formatBytes(d.currentVersion?.fileSize)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="timeline" className="mt-0">
              {timeline.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm border bg-card rounded-md shadow-sm">
                  No activity yet.
                </div>
              ) : (
                <Card className="shadow-sm">
                  <CardContent className="pt-6">
                    <div className="relative pl-6 border-l-2 border-muted space-y-8 py-2">
                      {timeline.map((t) => (
                        <div key={t.id} className="relative">
                          <div className="absolute -left-[33px] top-1 h-6 w-6 rounded-full bg-primary flex items-center justify-center ring-4 ring-background z-10">
                            <Clock className="h-3 w-3 text-primary-foreground" />
                          </div>
                          <div className="bg-muted/30 rounded-lg p-3 border border-border/50 hover:bg-muted/50 transition-colors">
                            <div className="flex justify-between items-start mb-1">
                              <span className="font-semibold text-sm">
                                {t.title ?? (t.kind === "note" ? "Note" : t.type ?? t.kind)}
                              </span>
                              <span className="text-[11px] text-muted-foreground flex-shrink-0">
                                {formatDateTime(t.occurredAt)}
                              </span>
                            </div>
                            {t.body && (
                              <div className="text-sm text-muted-foreground whitespace-pre-wrap mt-0.5">
                                {t.body}
                              </div>
                            )}
                            {t.actorName && (
                              <div className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/50" />
                                by {t.actorName}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </WorkspaceMain>

        <WorkspaceSidebar>
          <Card className="shadow-sm border-border/50">
            <CardHeader className="pb-3 bg-secondary/30">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" /> Details
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <InfoRow label="Industry" icon={<Building2 className="h-4 w-4" />} value={org.industry} />
              <InfoRow
                label="Website"
                icon={<Globe className="h-4 w-4" />}
                value={
                  org.website && (
                    <a href={org.website} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {org.website}
                    </a>
                  )
                }
              />
              <InfoRow
                label="Phone"
                icon={<Phone className="h-4 w-4" />}
                value={
                  org.phone && (
                    <a href={`tel:${org.phone}`} className="hover:underline">
                      {org.phone}
                    </a>
                  )
                }
              />
              <InfoRow
                label="Email"
                icon={<Mail className="h-4 w-4" />}
                value={
                  org.email && (
                    <a href={`mailto:${org.email}`} className="text-primary hover:underline">
                      {org.email}
                    </a>
                  )
                }
              />
              <InfoRow label="Address" icon={<MapPin className="h-4 w-4" />} value={org.address} />
              <InfoRow label="Country" icon={<MapPin className="h-4 w-4" />} value={org.country} />
              <InfoRow label="Size" icon={<Users className="h-4 w-4" />} value={org.size} />

              {org.notes && (
                <div className="pt-3 border-t mt-3">
                  <div className="text-xs text-muted-foreground mb-1">Notes</div>
                  <div className="text-sm whitespace-pre-wrap">{org.notes}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {org.recentEmployeesMet && org.recentEmployeesMet.length > 0 && (
            <Card className="shadow-sm border-border/50">
              <CardHeader className="pb-3 bg-secondary/30">
                <CardTitle className="text-base flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-primary" /> Recently Met
                </CardTitle>
                <CardDescription className="text-xs">
                  People from this company you interacted with most recently.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-4 space-y-3">
                {org.recentEmployeesMet.map((emp) => (
                  <Link
                    key={emp.contactId}
                    href={`/admin/contacts/${emp.contactId}`}
                    className="flex items-start justify-between gap-2 rounded-md border p-3 hover:bg-muted/50 transition-colors bg-card"
                  >
                    <div>
                      <div className="text-sm font-medium">{emp.fullName ?? "—"}</div>
                      {emp.jobTitle && <div className="text-xs text-muted-foreground">{emp.jobTitle}</div>}
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(emp.lastInteractionDate)}
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {Number.isFinite(id) && id > 0 && (
            <>
              <SalesCopilotPanel entityType="organization" id={id} />
              <WorkflowIntelligencePanel entityType="organization" id={id} />
              <AiInsightsPanel entityType="organization" id={id} />
            </>
          )}
        </WorkspaceSidebar>
      </WorkspaceContent>
    </WorkspaceShell>
  );
}
