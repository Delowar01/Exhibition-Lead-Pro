import React from "react";
import { format, parseISO } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListUsers,
  useCreateUser,
  useDeleteUser,
  useEnableUser,
  useDisableUser,
  useForceLogoutUser,
  useRequestUserPasswordReset,
  useSetUserRoles,
  useGetUser,
  getGetUserQueryKey,
  useGetUserLoginHistory,
  useListRoles,
  getListUsersQueryKey,
  getGetUserLoginHistoryQueryKey,
  User,
  UserInput,
  UserInputRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, MoreHorizontal, Ban, CheckCircle2, LogOut, KeyRound, Trash2, History, Shield } from "lucide-react";

const ASSIGNABLE_ROLES: { value: UserInputRole; label: string }[] = [
  { value: "primary_admin", label: "Primary Admin" },
  { value: "admin", label: "Admin" },
  { value: "employee", label: "Employee" },
];

function fmt(s?: string | null) {
  if (!s) return "—";
  try {
    return format(parseISO(s), "MMM d, yyyy HH:mm");
  } catch {
    return s;
  }
}

function CreateUserDialog({ companyId, onSaved }: { companyId?: number | null; onSaved: () => void }) {
  const { toast } = useToast();
  const create = useCreateUser();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<UserInputRole>("employee");
  const [password, setPassword] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setEmail(""); setName(""); setRole("employee"); setPassword("");
    }
  }, [open]);

  const onSubmit = () => {
    if (!email.trim() || !name.trim()) {
      toast({ variant: "destructive", title: "Name and email are required" });
      return;
    }
    const data: UserInput = {
      email: email.trim(),
      name: name.trim(),
      role,
      companyId: companyId ?? null,
      password: password.trim() || null,
    };
    create.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: "Team member added" });
          setOpen(false);
          onSaved();
        },
        onError: () => toast({ variant: "destructive", title: "Failed to add member" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><UserPlus className="mr-2 h-4 w-4" />Invite Member</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>Create a new user account in your organization.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cu-name">Full Name</Label>
            <Input id="cu-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cu-email">Email</Label>
            <Input id="cu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserInputRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cu-pass">Temp Password</Label>
              <Input id="cu-pass" value={password} placeholder="Optional" onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={create.isPending}>{create.isPending ? "Adding..." : "Add Member"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RolesDialog({ user, open, onOpenChange, onSaved }: {
  user: User | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const { data: rolesData } = useListRoles();
  const setRoles = useSetUserRoles();
  const uid = user?.id ?? 0;
  const { data: detail, isLoading: detailLoading } = useGetUser(uid, {
    query: { enabled: open && !!user, queryKey: getGetUserQueryKey(uid) },
  });
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  React.useEffect(() => {
    if (open && detail) {
      setSelected(new Set(detail.roleIds ?? []));
    }
  }, [open, detail]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSubmit = () => {
    if (!user) return;
    setRoles.mutate(
      { id: user.id, data: { roleIds: Array.from(selected) } },
      {
        onSuccess: () => {
          toast({ title: "Roles updated" });
          onOpenChange(false);
          onSaved();
        },
        onError: () => toast({ variant: "destructive", title: "Failed to update roles" }),
      },
    );
  };

  const assignable = (rolesData?.roles ?? []).filter((r) => !r.isSystem && r.companyId !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Roles{user ? ` — ${user.name}` : ""}</DialogTitle>
          <DialogDescription>Custom roles grant additional permissions on top of the base role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {assignable.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No custom roles available. Create one under Roles & Permissions.</p>
          ) : (
            assignable.map((r) => (
              <label key={r.id} className="flex items-center gap-3 rounded-md border p-3 cursor-pointer">
                <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                <div>
                  <div className="text-sm font-medium">{r.name}</div>
                  {r.description && <div className="text-xs text-muted-foreground">{r.description}</div>}
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={setRoles.isPending || detailLoading || assignable.length === 0}>
            {setRoles.isPending ? "Saving..." : "Save Roles"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoginHistoryDialog({ user, open, onOpenChange }: {
  user: User | null; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const id = user?.id ?? 0;
  const { data, isLoading } = useGetUserLoginHistory(id, {
    query: { enabled: open && !!user, queryKey: getGetUserLoginHistoryQueryKey(id) },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Login History{user ? ` — ${user.name}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="rounded-md border max-h-[60vh] overflow-y-auto">
          <Table>
            <TableHeader className="bg-secondary/50">
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : !data?.history?.length ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No login history.</TableCell></TableRow>
              ) : (
                data.history.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{fmt(e.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.ipAddress ?? "—"}</TableCell>
                    <TableCell><Badge variant={e.success ? "default" : "destructive"}>{e.success ? "Success" : "Failed"}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.reason ?? "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminTeam() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListUsers({ companyId: user?.companyId ?? undefined, limit: 50 });

  const enable = useEnableUser();
  const disable = useDisableUser();
  const forceLogout = useForceLogoutUser();
  const resetPw = useRequestUserPasswordReset();
  const del = useDeleteUser();

  const [rolesUser, setRolesUser] = React.useState<User | null>(null);
  const [historyUser, setHistoryUser] = React.useState<User | null>(null);
  const [deleteUser, setDeleteUser] = React.useState<User | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const action = (label: string) => ({
    onSuccess: () => { toast({ title: label }); refresh(); },
    onError: () => toast({ variant: "destructive", title: `Failed: ${label.toLowerCase()}` }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Team Members</h1>
        <CreateUserDialog companyId={user?.companyId} onSaved={refresh} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Members</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader className="bg-secondary/50">
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Loading team...</TableCell></TableRow>
                ) : data?.users.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No team members found.</TableCell></TableRow>
                ) : (
                  data?.users.map((member) => {
                    const isSelf = member.id === user?.id;
                    return (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="font-medium">{member.name}</div>
                          <div className="text-xs text-muted-foreground">{member.email}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">{member.role.replace("_", " ")}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={member.isActive ? "default" : "destructive"}>
                            {member.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setRolesUser(member)}>
                                <Shield className="mr-2 h-4 w-4" /> Assign Roles
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setHistoryUser(member)}>
                                <History className="mr-2 h-4 w-4" /> Login History
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {member.isActive ? (
                                <DropdownMenuItem disabled={isSelf} onClick={() => disable.mutate({ id: member.id }, action("User disabled"))}>
                                  <Ban className="mr-2 h-4 w-4" /> Disable
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onClick={() => enable.mutate({ id: member.id }, action("User enabled"))}>
                                  <CheckCircle2 className="mr-2 h-4 w-4" /> Enable
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => forceLogout.mutate({ id: member.id }, action("Sessions revoked"))}>
                                <LogOut className="mr-2 h-4 w-4" /> Force Logout
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => resetPw.mutate({ id: member.id }, action("Password reset requested"))}>
                                <KeyRound className="mr-2 h-4 w-4" /> Reset Password
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={isSelf}
                                className="text-destructive focus:text-destructive"
                                onClick={() => setDeleteUser(member)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" /> Remove
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
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

      <RolesDialog user={rolesUser} open={!!rolesUser} onOpenChange={(o) => !o && setRolesUser(null)} onSaved={refresh} />
      <LoginHistoryDialog user={historyUser} open={!!historyUser} onOpenChange={(o) => !o && setHistoryUser(null)} />

      <AlertDialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deleteUser?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deactivates the account and revokes access. Their historical records are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteUser) del.mutate({ id: deleteUser.id }, action("User removed"));
                setDeleteUser(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
