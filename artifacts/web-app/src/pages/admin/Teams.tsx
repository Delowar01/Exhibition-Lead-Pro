import React from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListTeams,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  useArchiveTeam,
  useRestoreTeam,
  useListTeamMembers,
  useAssignTeamMembers,
  useListDepartments,
  useListEmployeeDirectory,
  getListTeamsQueryKey,
  getListTeamMembersQueryKey,
  Team,
  TeamInput,
  TeamUpdate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Network, Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, Users } from "lucide-react";

const NONE = "__none__";

function TeamDialog({
  open, onOpenChange, editing, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Team | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const { data: deptData } = useListDepartments({ status: "active", limit: 100 });
  const { data: dir } = useListEmployeeDirectory({ limit: 200 });
  const departments = deptData?.departments ?? [];
  const employees = dir?.users ?? [];

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [departmentId, setDepartmentId] = React.useState<string>(NONE);
  const [leaderId, setLeaderId] = React.useState<string>(NONE);

  React.useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setDescription(editing?.description ?? "");
      setDepartmentId(editing?.departmentId ? String(editing.departmentId) : NONE);
      setLeaderId(editing?.leaderId ? String(editing.leaderId) : NONE);
    }
  }, [open, editing]);

  const onSubmit = () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    const dept = departmentId === NONE ? null : Number(departmentId);
    const leader = leaderId === NONE ? null : Number(leaderId);

    if (editing) {
      const data: TeamUpdate = {
        name: name.trim(),
        description: description.trim() || null,
        departmentId: dept,
        leaderId: leader,
      };
      update.mutate(
        { id: editing.id, data },
        {
          onSuccess: () => { toast({ title: "Team updated" }); onOpenChange(false); onSaved(); },
          onError: () => toast({ variant: "destructive", title: "Failed to update team" }),
        },
      );
    } else {
      const data: TeamInput = {
        name: name.trim(),
        description: description.trim() || null,
        departmentId: dept,
        leaderId: leader,
      };
      create.mutate(
        { data },
        {
          onSuccess: () => { toast({ title: "Team created" }); onOpenChange(false); onSaved(); },
          onError: () => toast({ variant: "destructive", title: "Failed to create team" }),
        },
      );
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Team" : "New Team"}</DialogTitle>
          <DialogDescription>Teams group employees under a department with an optional team leader.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="team-name">Name</Label>
            <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-desc">Description</Label>
            <Textarea id="team-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Team Leader</Label>
              <Select value={leaderId} onValueChange={setLeaderId}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {employees.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? "Saving..." : editing ? "Save Changes" : "Create Team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageMembersDialog({
  team, open, onOpenChange, onSaved,
}: {
  team: Team | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const assign = useAssignTeamMembers();
  const { data: dir } = useListEmployeeDirectory({ limit: 200 });
  const employees = dir?.users ?? [];
  const tid = team?.id ?? 0;
  const { data: members } = useListTeamMembers(tid, {
    query: { enabled: open && !!team, queryKey: getListTeamMembersQueryKey(tid) },
  });

  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  React.useEffect(() => {
    if (open && members) {
      setSelected(new Set(members.users.map((u) => u.id)));
    }
  }, [open, members]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSubmit = () => {
    if (!team) return;
    assign.mutate(
      { id: team.id, data: { userIds: Array.from(selected) } },
      {
        onSuccess: () => { toast({ title: "Members updated" }); onOpenChange(false); onSaved(); },
        onError: () => toast({ variant: "destructive", title: "Failed to update members" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Members{team ? ` — ${team.name}` : ""}</DialogTitle>
          <DialogDescription>Select the employees that belong to this team.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {employees.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No employees available.</p>
          ) : (
            employees.map((u) => (
              <label key={u.id} className="flex items-center gap-3 rounded-md border p-3 cursor-pointer">
                <Checkbox checked={selected.has(u.id)} onCheckedChange={() => toggle(u.id)} />
                <div>
                  <div className="text-sm font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.jobTitle || u.email}</div>
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={assign.isPending}>
            {assign.isPending ? "Saving..." : "Save Members"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminTeams() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [deptFilter, setDeptFilter] = React.useState<string>("all");

  const { data: deptData } = useListDepartments({ status: "active", limit: 100 });
  const departments = deptData?.departments ?? [];

  const { data, isLoading } = useListTeams({
    search: search.trim() || undefined,
    departmentId: deptFilter === "all" ? undefined : Number(deptFilter),
    limit: 100,
  });
  const teams = data?.teams ?? [];

  const archive = useArchiveTeam();
  const restore = useRestoreTeam();
  const del = useDeleteTeam();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Team | null>(null);
  const [membersTeam, setMembersTeam] = React.useState<Team | null>(null);
  const [deleting, setDeleting] = React.useState<Team | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (t: Team) => { setEditing(t); setDialogOpen(true); };

  const action = (label: string) => ({
    onSuccess: () => { toast({ title: label }); refresh(); },
    onError: () => toast({ variant: "destructive", title: `Failed: ${label.toLowerCase()}` }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Teams</h1>
          <p className="text-muted-foreground mt-1">Group employees into teams within departments.</p>
        </div>
        <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New Team</Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border mb-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <CardTitle>All Teams</CardTitle>
              <CardDescription>{data?.total ?? 0} total</CardDescription>
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Input
                placeholder="Search teams..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="md:w-64"
              />
              <Select value={deptFilter} onValueChange={setDeptFilter}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Departments</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
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
                  <TableHead>Team</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Leader</TableHead>
                  <TableHead className="text-center">Members</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">Loading teams...</TableCell></TableRow>
                ) : teams.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No teams yet. Create your first one.</TableCell></TableRow>
                ) : (
                  teams.map((t) => (
                    <TableRow key={t.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2 font-medium">
                          <Network className="h-4 w-4 text-muted-foreground" />
                          {t.name}
                        </div>
                        {t.description && <div className="text-xs text-muted-foreground mt-0.5 ml-6 max-w-xs truncate">{t.description}</div>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t.departmentName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t.leaderName ?? "—"}</TableCell>
                      <TableCell className="text-center">
                        <span className="inline-flex items-center gap-1 text-sm"><Users className="h-3.5 w-3.5 text-muted-foreground" />{t.memberCount ?? 0}</span>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={t.status === "active" ? "default" : "secondary"} className="capitalize">{t.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setMembersTeam(t)}>
                              <Users className="mr-2 h-4 w-4" /> Manage Members
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit(t)}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            {t.status === "active" ? (
                              <DropdownMenuItem onClick={() => archive.mutate({ id: t.id }, action("Team archived"))}>
                                <Archive className="mr-2 h-4 w-4" /> Archive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => restore.mutate({ id: t.id }, action("Team restored"))}>
                                <ArchiveRestore className="mr-2 h-4 w-4" /> Restore
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleting(t)}>
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

      <TeamDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} onSaved={refresh} />
      <ManageMembersDialog
        team={membersTeam}
        open={!!membersTeam}
        onOpenChange={(o) => !o && setMembersTeam(null)}
        onSaved={refresh}
      />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the team. Members will be unassigned (not deleted).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleting) return;
                del.mutate({ id: deleting.id }, {
                  onSuccess: () => { toast({ title: "Team deleted" }); setDeleting(null); refresh(); },
                  onError: () => { toast({ variant: "destructive", title: "Failed to delete team" }); setDeleting(null); },
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
