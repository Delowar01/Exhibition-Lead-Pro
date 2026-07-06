import React from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  useGetCrmOrganization,
  useListCrmOrganizationContacts,
  useListCrmOrganizationLeads,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, Building2, Globe, Phone, Mail, MapPin, Users, Target, DollarSign } from "lucide-react";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export default function AdminCompanyDetail() {
  const [, params] = useRoute("/admin/companies/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);

  const { data: org, isLoading } = useGetCrmOrganization(id);
  const { data: contactsData } = useListCrmOrganizationContacts(id);
  const { data: leadsData } = useListCrmOrganizationLeads(id);
  const contacts = contactsData?.contacts ?? [];
  const leads = leadsData?.leads ?? [];

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
        <Card className="lg:col-span-1">
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

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Relationships</CardTitle>
            <CardDescription>Contacts and leads at this company.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="contacts">
              <TabsList>
                <TabsTrigger value="contacts">Contacts ({contacts.length})</TabsTrigger>
                <TabsTrigger value="leads">Leads ({leads.length})</TabsTrigger>
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
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
