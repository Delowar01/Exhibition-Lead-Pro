import React from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListDepartments,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  useArchiveDepartment,
  useRestoreDepartment,
  useListEmployeeDirectory,
  getListDepartmentsQueryKey,
  Department,
  DepartmentInput,
  DepartmentUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
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
import { Building2, Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Users, Network } from "lucide-react";

const NONE = "__none__";

function DepartmentDialog({
  open, onOpenChange, editing, departments, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Department | null;
  departments: Department[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const { data: dir } = useListEmployeeDirectory({ limit: 200 });
  const employees = dir?.users ?? [];

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [headId, setHeadId] = React.useState<string>(NONE);
  const [parentDepartmentId, setParentDepartmentId] = React.useState<string>(NONE);

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setDescription(editing?.description ?? "");
      setHeadId(editing?.headId ? String(editing.headId) : NONE);
      setParentDepartmentId(editing?.parentDepartmentId ? String(editing.parentDepartmentId) : NONE);
    }
  }, [open, editing]);

  const parentOptions = departments.filter((d) => d.id !== editing?.id);

  const onSubmit = () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    const head = headId === NONE ? null : Number(headId);
    const parent = parentDepartmentId === NONE ? null : Number(parentDepartmentId);

    if (editing) {
      const data: DepartmentUpdate = {
        name: name.trim(),
        description: description.trim() || null,
        headId: head,
        parentDepartmentId: parent,
      };
      update.mutate(
        { id: editing.id, data },
        {
          onSuccess: () => { toast({ title: "Department updated" }); onOpenChange(false); onSaved(); },
          onError: () => toast({ variant: "destructive", title: "Failed to update department" }),
        },
      );
    } else {
      const data: DepartmentInput = {
        name: name.trim(),
        description: description.trim() || null,
        headId: head,
        parentDepartmentId: parent,
      };
      create.mutate(
        { data },
        {
          onSuccess: () => { toast({ title: "Department created" }); onOpenChange(false); onSaved(); },
          onError: () => toast({ variant: "destructive", title: "Failed to create department" }),
        },
      );
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Department" : "New Department"}</DialogTitle>
          <DialogDescription>Organize your company into departments with an optional head and parent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dept-name">Name</Label>
            <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dept-desc">Description</Label>
            <Textarea id="dept-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Department Head</Label>
              <Select value={headId} onValueChange={setHeadId}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {employees.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Parent Department</Label>
              <Select value={parentDepartmentId} onValueChange={setParentDepartmentId}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {parentOptions.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? "Saving..." : editing ? "Save Changes" : "Create Department"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminDepartments() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");

  const { data, isLoading } = useListDepartments({
    search: search.trim() || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });
  const departments = data?.departments ?? [];

  const archive = useArchiveDepartment();
  const restore = useRestoreDepartment();
  const del = useDeleteDepartment();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Department | null>(null);
  const [deleting, setDeleting] = React.useState<Department | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (d: Department) => { setEditing(d); setDialogOpen(true); };

  const action = (label: string) => ({
    onSuccess: () => { toast({ title: label }); refresh(); },
    onError: () => toast({ variant: "destructive", title: `Failed: ${label.toLowerCase()}` }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Departments</h1>
          <p className="text-muted-foreground mt-1">Structure your organization into departments.</p>
        </div>
        <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New Department</Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border mb-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <CardTitle>All Departments</CardTitle>
              <CardDescription>{data?.total ?? 0} total</CardDescription>
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Input
                placeholder="Search departments..."
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
                  <TableHead>Department</TableHead>
                  <TableHead>Head</TableHead>
                  <TableHead>Parent</TableHead>
                  <TableHead className="text-center">Teams</TableHead>
                  <TableHead className="text-center">Employees</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">Loading departments...</TableCell></TableRow>
                ) : departments.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">No departments yet. Create your first one.</TableCell></TableRow>
                ) : (
                  departments.map((d) => (
                    <TableRow key={d.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2 font-medium">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          {d.name}
                        </div>
                        {d.description && <div className="text-xs text-muted-foreground mt-0.5 ml-6 max-w-xs truncate">{d.description}</div>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.headName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.parentDepartmentName ?? "—"}</TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex items-center gap-1 text-sm"><Network className="h-3.5 w-3.5 text-muted-foreground" />{d.teamCount ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex items-center gap-1 text-sm"><Users className="h-3.5 w-3.5 text-muted-foreground" />{d.employeeCount ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={d.status === "active" ? "default" : "secondary"} className="capitalize">{d.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(d)}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            {d.status === "active" ? (
                              <DropdownMenuItem onClick={() => archive.mutate({ id: d.id }, action("Department archived"))}>
                                <Archive className="mr-2 h-4 w-4" /> Archive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => restore.mutate({ id: d.id }, action("Department restored"))}>
                                <ArchiveRestore className="mr-2 h-4 w-4" /> Restore
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleting(d)}>
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

      <DepartmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        departments={departments}
        onSaved={refresh}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the department. Teams and employees in it will be unassigned (not deleted).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleting) return;
                del.mutate({ id: deleting.id }, {
                  onSuccess: () => { toast({ title: "Department deleted" }); setDeleting(null); refresh(); },
                  onError: () => { toast({ variant: "destructive", title: "Failed to delete department" }); setDeleting(null); },
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
