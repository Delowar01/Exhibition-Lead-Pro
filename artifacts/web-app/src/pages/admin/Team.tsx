import React from "react";
import { format, parseISO } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListUsers,
  useCreateUser,
  useUpdateUser,
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
  useListDepartments,
  useListTeams,
  useListEmployeeDirectory,
  getListUsersQueryKey,
  getGetUserLoginHistoryQueryKey,
  useListInvitations,
  useCreateInvitation,
  useResendInvitation,
  useCancelInvitation,
  getListInvitationsQueryKey,
  User,
  UserInput,
  UserInputRole,
  UserUpdate,
  UserUpdateEmploymentStatus,
  Invitation,
  CreateInvitationInput,
  CreateInvitationInputRole,
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
import { UserPlus, MoreHorizontal, Ban, CheckCircle2, LogOut, KeyRound, Trash2, History, Shield, Mail, Send, X, Briefcase } from "lucide-react";
import { ListSkeleton } from "@/components/ds";

const NONE = "__none__";

const EMPLOYMENT_STATUSES: { value: UserUpdateEmploymentStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "probation", label: "Probation" },
  { value: "on_leave", label: "On Leave" },
  { value: "suspended", label: "Suspended" },
  { value: "offboarded", label: "Offboarded" },
];

const ASSIGNABLE_ROLES: { value: UserInputRole; label: string }[] = [
  { value: "primary_admin", label: "Primary Admin" },
  { value: "admin", label: "Admin" },
  { value: "employee", label: "Employee" },
];

const INVITE_ROLES: { value: CreateInvitationInputRole; label: string }[] = [
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

function InviteByEmailDialog({ companyId, onSaved }: { companyId?: number | null; onSaved: () => void }) {
  const { toast } = useToast();
  const create = useCreateInvitation();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<CreateInvitationInputRole>("employee");

  React.useEffect(() => {
    if (open) {
      setEmail(""); setName(""); setRole("employee");
    }
  }, [open]);

  const onSubmit = () => {
    if (!email.trim()) {
      toast({ variant: "destructive", title: "Email is required" });
      return;
    }
    const data: CreateInvitationInput = {
      email: email.trim(),
      name: name.trim() || null,
      role,
      companyId: companyId ?? null,
    };
    create.mutate(
      { data },
      {
        onSuccess: (res) => {
          // Honest delivery messaging: creation ≠ delivery. Reflect the actual
          // email status reported by the server.
          const status = res?.invitation?.emailStatus;
          if (status === "skipped") {
            toast({
              title: "Invitation created — email not sent",
              description: "The email service is not configured. Share the invitation link manually or configure SMTP.",
              variant: "destructive",
            });
          } else if (status === "failed") {
            toast({ variant: "destructive", title: "Invitation created — email failed to send", description: "You can retry with Resend." });
          } else if (status === "sent") {
            toast({ title: "Invitation email sent" });
          } else {
            toast({ title: "Invitation created", description: "Email queued for delivery." });
          }
          setOpen(false);
          onSaved();
        },
        onError: () => toast({ variant: "destructive", title: "Failed to create invitation" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Mail className="mr-2 h-4 w-4" />Invite by Email</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite by Email</DialogTitle>
          <DialogDescription>Send an email invitation. The recipient sets their own password when they accept.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inv-email">Email</Label>
            <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-name">Full Name (optional)</Label>
            <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as CreateInvitationInputRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {INVITE_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={create.isPending}>{create.isPending ? "Sending..." : "Send Invitation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const EMAIL_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  queued: { label: "Email queued", className: "bg-secondary text-secondary-foreground" },
  sent: { label: "Email sent", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  failed: { label: "Email failed", className: "bg-destructive/10 text-destructive" },
  skipped: { label: "Email not configured", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
};

const RESEND_COOLDOWN_MS = 30_000;

function PendingInvitations({ companyId }: { companyId?: number | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListInvitations(
    { companyId: companyId ?? undefined },
    // Keep delivery status fresh while the async email worker updates rows.
    { query: { refetchInterval: 15_000, queryKey: getListInvitationsQueryKey({ companyId: companyId ?? undefined }) } },
  );
  const resend = useResendInvitation();
  const cancel = useCancelInvitation();
  // Per-invitation resend cooldown so the button can't be hammered into a mail flood.
  const [resentAt, setResentAt] = React.useState<Record<number, number>>({});
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const t = setInterval(forceTick, 5_000);
    return () => clearInterval(t);
  }, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() });

  const invitations = (data?.invitations ?? []).filter((inv) => inv.status === "pending");

  if (!isLoading && invitations.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending Invitations</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-secondary/50">
              <TableRow>
                <TableHead>Invitee</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading invitations...</TableCell></TableRow>
              ) : (
                invitations.map((inv: Invitation) => {
                  const expired = new Date(inv.expiresAt).getTime() < Date.now();
                  const emailBadge = EMAIL_STATUS_BADGE[inv.emailStatus ?? "queued"] ?? EMAIL_STATUS_BADGE.queued;
                  const cooldownLeft = Math.max(0, (resentAt[inv.id] ?? 0) + RESEND_COOLDOWN_MS - Date.now());
                  return (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <div className="font-medium">{inv.name || "—"}</div>
                      <div className="text-xs text-muted-foreground">{inv.email}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{inv.role.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={emailBadge.className} title={inv.emailError ?? undefined}>{emailBadge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {expired ? <Badge className="bg-destructive/10 text-destructive">Expired</Badge> : fmt(inv.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={cooldownLeft > 0 ? `Resent — wait ${Math.ceil(cooldownLeft / 1000)}s` : "Resend"}
                          disabled={resend.isPending || cooldownLeft > 0}
                          onClick={() => resend.mutate({ id: inv.id }, {
                            onSuccess: (res) => {
                              setResentAt((m) => ({ ...m, [inv.id]: Date.now() }));
                              const status = res?.invitation?.emailStatus;
                              if (status === "skipped") {
                                toast({ variant: "destructive", title: "Invitation renewed — email not sent", description: "The email service is not configured." });
                              } else {
                                toast({ title: "Invitation resent", description: status === "sent" ? "Email sent." : "Email queued for delivery." });
                              }
                              refresh();
                            },
                            onError: () => toast({ variant: "destructive", title: "Failed to resend" }),
                          })}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Cancel"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate({ id: inv.id }, {
                            onSuccess: () => { toast({ title: "Invitation cancelled" }); refresh(); },
                            onError: () => toast({ variant: "destructive", title: "Failed to cancel" }),
                          })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
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
                <TableRow><TableCell colSpan={4} className="py-2"><ListSkeleton rows={4} /></TableCell></TableRow>
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

function OrgProfileDialog({ user, open, onOpenChange, onSaved }: {
  user: User | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateUser();
  const { data: deptData } = useListDepartments({ status: "active", limit: 100 });
  const { data: teamData } = useListTeams({ limit: 100 });
  const { data: dir } = useListEmployeeDirectory({ limit: 200 });
  const departments = deptData?.departments ?? [];
  const teams = teamData?.teams ?? [];
  const managers = (dir?.users ?? []).filter((u) => u.id !== user?.id);

  const [employeeId, setEmployeeId] = React.useState("");
  const [jobTitle, setJobTitle] = React.useState("");
  const [employmentStatus, setEmploymentStatus] = React.useState<UserUpdateEmploymentStatus>("active");
  const [joiningDate, setJoiningDate] = React.useState("");
  const [managerId, setManagerId] = React.useState<string>(NONE);
  const [departmentId, setDepartmentId] = React.useState<string>(NONE);
  const [teamId, setTeamId] = React.useState<string>(NONE);

  const uid = user?.id ?? 0;
  const { data: detail } = useGetUser(uid, {
    query: { enabled: open && !!user, queryKey: getGetUserQueryKey(uid) },
  });

  React.useEffect(() => {
    if (open && detail) {
      setEmployeeId(detail.employeeId ?? "");
      setJobTitle(detail.jobTitle ?? "");
      setEmploymentStatus((detail.employmentStatus as UserUpdateEmploymentStatus) ?? "active");
      setJoiningDate(detail.joiningDate ?? "");
      setManagerId(detail.managerId ? String(detail.managerId) : NONE);
      setDepartmentId(detail.departmentId ? String(detail.departmentId) : NONE);
      setTeamId(detail.teamId ? String(detail.teamId) : NONE);
    }
  }, [open, detail]);

  const onSubmit = () => {
    if (!user) return;
    const data: UserUpdate = {
      employeeId: employeeId.trim() || null,
      jobTitle: jobTitle.trim() || null,
      employmentStatus,
      joiningDate: joiningDate || null,
      managerId: managerId === NONE ? null : Number(managerId),
      departmentId: departmentId === NONE ? null : Number(departmentId),
      teamId: teamId === NONE ? null : Number(teamId),
    };
    update.mutate(
      { id: user.id, data },
      {
        onSuccess: () => { toast({ title: "Org profile updated" }); onOpenChange(false); onSaved(); },
        onError: () => toast({ variant: "destructive", title: "Failed to update org profile" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Org Profile{user ? ` — ${user.name}` : ""}</DialogTitle>
          <DialogDescription>Assign employment details, reporting manager, department and team.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="op-empid">Employee ID</Label>
            <Input id="op-empid" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="op-title">Job Title</Label>
            <Input id="op-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Employment Status</Label>
            <Select value={employmentStatus} onValueChange={(v) => setEmploymentStatus(v as UserUpdateEmploymentStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="op-join">Joining Date</Label>
            <Input id="op-join" type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Reporting Manager</Label>
            <Select value={managerId} onValueChange={setManagerId}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {managers.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
          <div className="space-y-2 col-span-2">
            <Label>Team</Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={update.isPending}>
            {update.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </DialogFooter>
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
  const [orgUser, setOrgUser] = React.useState<User | null>(null);
  const [deleteUser, setDeleteUser] = React.useState<User | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const refreshInvites = () => queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() });

  const action = (label: string) => ({
    onSuccess: () => { toast({ title: label }); refresh(); },
    onError: () => toast({ variant: "destructive", title: `Failed: ${label.toLowerCase()}` }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Team Members</h1>
        <div className="flex items-center gap-2">
          <InviteByEmailDialog companyId={user?.companyId} onSaved={refreshInvites} />
          <CreateUserDialog companyId={user?.companyId} onSaved={refresh} />
        </div>
      </div>

      <PendingInvitations companyId={user?.companyId} />

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
                              <DropdownMenuItem onClick={() => setOrgUser(member)}>
                                <Briefcase className="mr-2 h-4 w-4" /> Org Profile
                              </DropdownMenuItem>
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
      <OrgProfileDialog user={orgUser} open={!!orgUser} onOpenChange={(o) => !o && setOrgUser(null)} onSaved={refresh} />
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
