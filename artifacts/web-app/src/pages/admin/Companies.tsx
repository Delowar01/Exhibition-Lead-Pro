import React from "react";
import { Link } from "wouter";
import {
  useListCrmOrganizations,
  useCreateCrmOrganization,
  useUpdateCrmOrganization,
  useDeleteCrmOrganization,
  useArchiveCrmOrganization,
  useRestoreCrmOrganization,
  getListCrmOrganizationsQueryKey,
  type CrmOrganization,
  type CrmOrganizationInput,
  type CrmOrganizationUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Building2, Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Users, Target, Search } from "lucide-react";
import { PageHeader, StatusBadge, EmptyState, TableSkeleton } from "@/components/ds";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function CompanyDialog({
  open, onOpenChange, editing, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: CrmOrganization | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateCrmOrganization();
  const update = useUpdateCrmOrganization();

  const [name, setName] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [country, setCountry] = React.useState("");
  const [size, setSize] = React.useState("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setIndustry(editing?.industry ?? "");
      setWebsite(editing?.website ?? "");
      setPhone(editing?.phone ?? "");
      setEmail(editing?.email ?? "");
      setAddress(editing?.address ?? "");
      setCountry(editing?.country ?? "");
      setSize(editing?.size ?? "");
      setNotes(editing?.notes ?? "");
    }
  }, [open, editing]);

  const onSubmit = () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    const payload = {
      name: name.trim(),
      industry: industry.trim() || null,
      website: website.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      country: country.trim() || null,
      size: size.trim() || null,
      notes: notes.trim() || null,
    };

    if (editing) {
      update.mutate(
        { id: editing.id, data: payload as CrmOrganizationUpdate },
        {
          onSuccess: () => { toast({ title: "Company updated" }); onOpenChange(false); onSaved(); },
          onError: (e) => toast({ variant: "destructive", title: String(e).includes("409") ? "A company with this name already exists" : "Failed to update company" }),
        },
      );
    } else {
      create.mutate(
        { data: payload as CrmOrganizationInput },
        {
          onSuccess: () => { toast({ title: "Company created" }); onOpenChange(false); onSaved(); },
          onError: (e) => toast({ variant: "destructive", title: String(e).includes("409") ? "A company with this name already exists" : "Failed to create company" }),
        },
      );
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:rounded-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Company" : "New Company"}</DialogTitle>
          <DialogDescription>Companies are the organizations your contacts and leads belong to.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 max-h-[65vh] overflow-y-auto px-1 py-2">
          <div className="space-y-2">
            <Label htmlFor="org-name">Name <span className="text-destructive">*</span></Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-industry">Industry</Label>
              <Input id="org-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Technology" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-size">Company Size</Label>
              <Input id="org-size" value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 11-50" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-website">Website</Label>
              <Input id="org-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-phone">Phone</Label>
              <Input id="org-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 ..." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-email">Email</Label>
              <Input id="org-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="contact@..." />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-country">Country</Label>
              <Input id="org-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="United States" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-address">Address</Label>
            <Input id="org-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St..." />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-notes">Notes</Label>
            <Textarea id="org-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Additional context..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? "Saving..." : editing ? "Save Changes" : "Create Company"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminCompanies() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");

  const { data, isLoading } = useListCrmOrganizations({
    search: search.trim() || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });
  const organizations = data?.organizations ?? [];

  const archive = useArchiveCrmOrganization();
  const restore = useRestoreCrmOrganization();
  const del = useDeleteCrmOrganization();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CrmOrganization | null>(null);
  const [deleting, setDeleting] = React.useState<CrmOrganization | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListCrmOrganizationsQueryKey() });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (o: CrmOrganization) => { setEditing(o); setDialogOpen(true); };

  const action = (label: string) => ({
    onSuccess: () => { toast({ title: label }); refresh(); },
    onError: () => toast({ variant: "destructive", title: `Failed: ${label.toLowerCase()}` }),
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader
        title="Companies"
        description="Manage the organizations your contacts and leads belong to."
        actions={
          <Button onClick={openNew} className="rounded-full shadow-sm hover-elevate">
            <Plus className="mr-2 h-4 w-4" />
            New Company
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-card p-2 rounded-xl shadow-sm border">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search companies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-transparent border-none shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[160px] bg-transparent border-none shadow-none font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="overflow-hidden shadow-sm border-border rounded-xl">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[300px]">Company</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Open Pipeline</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="w-[80px] text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-4">
                    <TableSkeleton rows={5} />
                  </TableCell>
                </TableRow>
              ) : organizations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="p-8">
                    <EmptyState
                      icon={Building2}
                      title="No companies found"
                      description={search ? "Try adjusting your search filters." : "Get started by adding your first company."}
                      action={
                        !search && (
                          <Button onClick={openNew} variant="outline" className="mt-2">
                            Add Company
                          </Button>
                        )
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                organizations.map((o) => (
                  <TableRow key={o.id} className="group hover:bg-muted/30 transition-colors">
                    <TableCell>
                      <Link href={`/admin/companies/${o.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
                        <div className="font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
                          {o.name}
                        </div>
                        {o.website && (
                          <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                            {o.website.replace(/^https?:\/\//, '')}
                          </div>
                        )}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{o.industry || "—"}</TableCell>
                    <TableCell className="text-right">
                      {o.contactCount ? (
                        <div className="inline-flex items-center gap-1.5 bg-muted px-2 py-0.5 rounded-md text-xs font-medium">
                          <Users className="h-3 w-3 text-muted-foreground" />
                          {o.contactCount}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {o.leadCount ? (
                        <div className="inline-flex items-center gap-1.5 bg-muted px-2 py-0.5 rounded-md text-xs font-medium">
                          <Target className="h-3 w-3 text-muted-foreground" />
                          {o.leadCount}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground/80">
                      {o.openLeadValue ? formatCurrency(o.openLeadValue) : "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <StatusBadge tone={o.status === "active" ? "success" : "neutral"} className="capitalize">
                        {o.status}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100">
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[160px]">
                          <DropdownMenuItem onClick={() => openEdit(o)}>
                            <Pencil className="mr-2 h-4 w-4 text-muted-foreground" /> Edit
                          </DropdownMenuItem>
                          {o.status === "active" ? (
                            <DropdownMenuItem onClick={() => archive.mutate({ id: o.id }, action("Company archived"))}>
                              <Archive className="mr-2 h-4 w-4 text-muted-foreground" /> Archive
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => restore.mutate({ id: o.id }, action("Company restored"))}>
                              <ArchiveRestore className="mr-2 h-4 w-4 text-muted-foreground" /> Restore
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleting(o)}>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <CompanyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={refresh}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="sm:rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the company. Contacts and leads linked to it will be unlinked (not deleted). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleting) return;
                del.mutate({ id: deleting.id }, {
                  onSuccess: () => { toast({ title: "Company deleted" }); setDeleting(null); refresh(); },
                  onError: () => { toast({ variant: "destructive", title: "Failed to delete company" }); setDeleting(null); },
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
