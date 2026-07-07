import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListContacts,
  getListContactsQueryKey,
  ContactStatus,
  type Contact as ContactType,
  type SearchContactsInput,
  type SearchContactsResult,
} from "@workspace/api-client-react";
import { AdvancedSearchDialog } from "@/components/search/AdvancedSearch";
import { SlidersHorizontal, X as XIcon, Search, UserPlus, Download, Upload, Mail, Phone, Calendar as CalendarIcon, Contact as ContactIcon, Flame, Snowflake, Thermometer, MoreHorizontal, Building2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { ExportDialog } from "@/components/import-export/ExportDialog";
import { ImportWizard } from "@/components/import-export/ImportWizard";
import { useImportExportPermissions } from "@/components/import-export/usePermissions";
import { PageHeader, StatusBadge, EmptyState, TableSkeleton } from "@/components/ds";

const TEMPERATURE_STYLES: Record<string, { label: string; tone: "destructive" | "warning" | "info"; icon: React.ReactNode }> = {
  hot: { label: "Hot", tone: "destructive", icon: <Flame className="h-3 w-3" /> },
  warm: { label: "Warm", tone: "warning", icon: <Thermometer className="h-3 w-3" /> },
  cold: { label: "Cold", tone: "info", icon: <Snowflake className="h-3 w-3" /> },
};

export default function AdminContacts() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedResult, setAdvancedResult] = useState<SearchContactsResult | null>(null);
  const [advancedInput, setAdvancedInput] = useState<SearchContactsInput | null>(null);
  const [advancedSummary, setAdvancedSummary] = useState("");
  const { canExport, canImportContacts } = useImportExportPermissions();

  const advancedActive = advancedResult !== null;

  const listParams = {
    search: search || undefined,
    status: status !== "all" ? status : undefined,
    limit: 50,
  };
  const { data: listData, isLoading: listLoading } = useListContacts(listParams, {
    query: { enabled: !advancedActive, queryKey: getListContactsQueryKey(listParams) },
  });

  const data: { contacts: ContactType[]; total?: number } | undefined = advancedActive
    ? { contacts: advancedResult.contacts, total: advancedResult.total }
    : listData;
  const isLoading = advancedActive ? false : listLoading;

  const clearAdvanced = () => {
    setAdvancedResult(null);
    setAdvancedInput(null);
    setAdvancedSummary("");
  };

  const exportFilters = { search, status };

  const getStatusTone = (status: string): "success" | "neutral" | "primary" | "destructive" => {
    switch (status) {
      case "new": return "primary";
      case "qualified": return "success";
      case "won": return "neutral";
      case "lost": return "destructive";
      default: return "neutral";
    }
  };

  const formatStatus = (status: string) => {
    return status.replace("_", " ");
  };

  return (
    <div className="space-y-6 max-w-[1400px] mx-auto pb-12">
      <PageHeader
        title="Contacts"
        description="Your centralized directory for leads, clients, and partners."
        actions={
          <div className="flex items-center gap-2">
            {canImportContacts && (
              <Button variant="outline" onClick={() => setImportOpen(true)} className="hidden sm:flex rounded-full">
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
            )}
            {canExport && (
              <Button variant="outline" onClick={() => setExportOpen(true)} className="hidden sm:flex rounded-full">
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            )}
            <Link href="/admin/contacts/new" className="inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 hover-elevate shadow-sm h-10 px-5 py-2">
              <UserPlus className="mr-2 h-4 w-4" />
              Add Contact
            </Link>
          </div>
        }
      />

      <div className="flex flex-col bg-card rounded-xl shadow-sm border border-border overflow-hidden">
        <div className="p-2 border-b border-border/50 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search name, company, email..." 
              className="pl-9 bg-transparent border-none shadow-none focus-visible:ring-0" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <Button 
              variant={advancedActive ? "secondary" : "ghost"} 
              size="sm"
              onClick={() => setAdvancedOpen(true)}
              className="rounded-full"
            >
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Advanced Filters
            </Button>
            <Select value={status} onValueChange={setStatus} disabled={advancedActive}>
              <SelectTrigger className="w-[140px] bg-transparent border-none shadow-none font-medium h-8 rounded-full">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All Statuses</SelectItem>
                {Object.values(ContactStatus).map(s => (
                  <SelectItem key={s} value={s} className="capitalize">{formatStatus(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {advancedActive && (
          <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground font-medium">Filtered by:</span>
              <span className="text-foreground truncate max-w-md">{advancedSummary}</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-xs font-medium bg-background px-2 py-1 rounded-md border shadow-sm">
                {data?.total ?? 0} results
              </div>
              <Button variant="ghost" size="sm" onClick={clearAdvanced} className="h-7 px-2 text-muted-foreground hover:text-foreground">
                <XIcon className="h-3.5 w-3.5 mr-1" /> Clear
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/20">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[280px]">Contact</TableHead>
                <TableHead className="w-[200px]">Organization</TableHead>
                <TableHead>Contact Info</TableHead>
                <TableHead className="text-center">Lead Status</TableHead>
                <TableHead className="text-center">Lifecycle</TableHead>
                <TableHead className="w-[100px] text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-4">
                    <TableSkeleton rows={8} />
                  </TableCell>
                </TableRow>
              ) : data?.contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-12">
                    <EmptyState
                      icon={ContactIcon}
                      title="No contacts found"
                      description={search || advancedActive ? "No contacts match your current filters." : "Your directory is empty. Add a new contact to get started."}
                      action={
                        (search || advancedActive) ? (
                          <Button variant="outline" onClick={() => { setSearch(""); clearAdvanced(); setStatus("all"); }} className="mt-2">
                            Clear Filters
                          </Button>
                        ) : null
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                data?.contacts.map((contact) => (
                  <TableRow key={contact.id} className="hover:bg-muted/30 group transition-colors cursor-pointer" onClick={() => navigate(`/admin/contacts/${contact.id}`)}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0 uppercase">
                          {contact.firstName?.charAt(0) || ""}{contact.lastName?.charAt(0) || ""}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate group-hover:text-primary transition-colors">
                            {contact.firstName} {contact.lastName}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {contact.jobTitle || "—"}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {contact.contactCompany ? (
                        <div className="flex items-center gap-1.5 text-sm text-foreground">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{contact.contactCompany}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                        {contact.email ? (
                          <div className="flex items-center gap-1.5 hover:text-foreground transition-colors w-fit" onClick={e => e.stopPropagation()}>
                            <Mail className="h-3 w-3 shrink-0" />
                            <a href={`mailto:${contact.email}`} className="truncate max-w-[180px]">{contact.email}</a>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-muted-foreground/50">
                            <Mail className="h-3 w-3 shrink-0" />
                            <span>—</span>
                          </div>
                        )}
                        {contact.mobile ? (
                          <div className="flex items-center gap-1.5 hover:text-foreground transition-colors w-fit" onClick={e => e.stopPropagation()}>
                            <Phone className="h-3 w-3 shrink-0" />
                            <a href={`tel:${contact.mobile}`} className="truncate max-w-[180px]">{contact.mobile}</a>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-muted-foreground/50">
                            <Phone className="h-3 w-3 shrink-0" />
                            <span>—</span>
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        {contact.leadTemperature && TEMPERATURE_STYLES[contact.leadTemperature] ? (
                          <StatusBadge tone={TEMPERATURE_STYLES[contact.leadTemperature].tone} showDot={false}>
                            {TEMPERATURE_STYLES[contact.leadTemperature].icon}
                            <span className="ml-1">{TEMPERATURE_STYLES[contact.leadTemperature].label}</span>
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                        {contact.leadScore != null && (
                          <div className="text-xs text-muted-foreground font-medium">Score: {contact.leadScore}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        <StatusBadge tone={getStatusTone(contact.status)} className="capitalize">
                          {formatStatus(contact.status)}
                        </StatusBadge>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <CalendarIcon className="h-3 w-3" />
                          {format(new Date(contact.createdAt), "MMM d")}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100" asChild onClick={e => e.stopPropagation()}>
                        <Link href={`/admin/contacts/${contact.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <AdvancedSearchDialog
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        initialInput={advancedInput}
        onApplied={(result, input, summary) => {
          setAdvancedResult(result);
          setAdvancedInput(input);
          setAdvancedSummary(summary);
        }}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        entityType="contact"
        filters={exportFilters}
        filteredCount={data?.total}
      />
      <ImportWizard open={importOpen} onOpenChange={setImportOpen} entityType="contact" />
    </div>
  );
}
