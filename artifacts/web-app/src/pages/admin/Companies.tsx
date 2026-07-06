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
  CrmOrganization,
  CrmOrganizationInput,
  CrmOrganizationUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import { Building2, Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Users, Target } from "lucide-react";

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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Company" : "New Company"}</DialogTitle>
          <DialogDescription>Companies are the organizations your contacts and leads belong to.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor="org-name">Name <span className="text-destructive">*</span></Label>
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-industry">Industry</Label>
              <Input id="org-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-size">Company Size</Label>
              <Input id="org-size" value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 11-50" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-website">Website</Label>
              <Input id="org-website" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-phone">Phone</Label>
              <Input id="org-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org-email">Email</Label>
              <Input id="org-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-country">Country</Label>
              <Input id="org-country" value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-address">Address</Label>
            <Input id="org-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-notes">Notes</Label>
            <Textarea id="org-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Companies</h1>
          <p className="text-muted-foreground mt-1">The organizations your contacts and leads belong to.</p>
        </div>
        <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New Company</Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border mb-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <CardTitle>All Companies</CardTitle>
              <CardDescription>{data?.total ?? 0} total</CardDescription>
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Input
                placeholder="Search companies..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="md:w-64"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
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
                  <TableHead>Company</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead className="text-center">Contacts</TableHead>
                  <TableHead className="text-center">Leads</TableHead>
                  <TableHead className="text-right">Open Pipeline</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">Loading companies...</TableCell></TableRow>
                ) : organizations.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">No companies yet. Create your first one.</TableCell></TableRow>
                ) : (
                  organizations.map((o) => (
                    <TableRow key={o.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <Link href={`/admin/companies/${o.id}`} className="flex items-center gap-2 font-medium hover:underline">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          {o.name}
                        </Link>
                        {o.website && <div className="text-xs text-muted-foreground mt-0.5 ml-6 max-w-xs truncate">{o.website}</div>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{o.industry ?? "—"}</TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex items-center gap-1 text-sm"><Users className="h-3.5 w-3.5 text-muted-foreground" />{o.contactCount ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex items-center gap-1 text-sm"><Target className="h-3.5 w-3.5 text-muted-foreground" />{o.leadCount ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{formatCurrency(o.openLeadValue ?? 0)}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant={o.status === "active" ? "default" : "secondary"} className="capitalize">{o.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(o)}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            {o.status === "active" ? (
                              <DropdownMenuItem onClick={() => archive.mutate({ id: o.id }, action("Company archived"))}>
                                <Archive className="mr-2 h-4 w-4" /> Archive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => restore.mutate({ id: o.id }, action("Company restored"))}>
                                <ArchiveRestore className="mr-2 h-4 w-4" /> Restore
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
        </CardContent>
      </Card>

      <CompanyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={refresh}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the company. Contacts and leads linked to it will be unlinked (not deleted).
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
