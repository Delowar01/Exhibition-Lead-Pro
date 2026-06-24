import React from "react";
import {
  useListRoles,
  useGetPermissionCatalog,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  getListRolesQueryKey,
  Role,
  RoleInput,
  PermissionGrant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, Plus, Pencil, Trash2, Lock } from "lucide-react";

function grantKey(module: string, action: string) {
  return `${module}:${action}`;
}

function RoleDialog({
  role,
  trigger,
  onSaved,
}: {
  role?: Role;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { data: catalog } = useGetPermissionCatalog();
  const create = useCreateRole();
  const update = useUpdateRole();

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (open) {
      setName(role?.name ?? "");
      setDescription(role?.description ?? "");
      setSelected(new Set((role?.permissions ?? []).map((p) => grantKey(p.module, p.action))));
    }
  }, [open, role]);

  const toggle = (module: string, action: string) => {
    const k = grantKey(module, action);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const onSubmit = () => {
    if (!name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    const permissions: PermissionGrant[] = Array.from(selected).map((k) => {
      const [module, action] = k.split(":");
      return { module, action };
    });
    const data: RoleInput = { name: name.trim(), description: description || null, permissions };
    const onSuccess = () => {
      toast({ title: role ? "Role updated" : "Role created" });
      setOpen(false);
      onSaved();
    };
    const onError = () => toast({ variant: "destructive", title: "Failed to save role" });
    if (role) update.mutate({ id: role.id, data }, { onSuccess, onError });
    else create.mutate({ data }, { onSuccess, onError });
  };

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{role ? "Edit Role" : "New Role"}</DialogTitle>
          <DialogDescription>Define a custom role and its granted permissions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-desc">Description</Label>
              <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <div className="space-y-3">
            <Label>Permissions</Label>
            <div className="space-y-3">
              {catalog?.modules.map((m) => (
                <div key={m.module} className="rounded-md border p-3">
                  <div className="font-medium text-sm mb-2">{m.label}</div>
                  <div className="flex flex-wrap gap-3">
                    {m.actions.map((action) => {
                      const k = grantKey(m.module, action);
                      return (
                        <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox checked={selected.has(k)} onCheckedChange={() => toggle(m.module, action)} />
                          <span className="capitalize">{action}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onSubmit} disabled={pending}>{pending ? "Saving..." : "Save Role"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminRoles() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListRoles();
  const del = useDeleteRole();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });

  const onDelete = (role: Role) => {
    del.mutate(
      { id: role.id },
      {
        onSuccess: () => {
          toast({ title: "Role deleted" });
          refresh();
        },
        onError: () => toast({ variant: "destructive", title: "Failed to delete role" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Roles & Permissions</h1>
        </div>
        <RoleDialog
          trigger={<Button><Plus className="mr-2 h-4 w-4" />New Role</Button>}
          onSaved={refresh}
        />
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading roles...</div>
      ) : !data?.roles?.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No custom roles yet. Create one to grant granular permissions to your team.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.roles.map((role) => {
            const locked = role.isSystem || role.companyId === null;
            return (
              <Card key={role.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      {role.name}
                      {locked && <Lock className="h-4 w-4 text-muted-foreground" />}
                      {role.isDefault && <Badge variant="secondary">Default</Badge>}
                    </CardTitle>
                    {!locked && (
                      <div className="flex items-center gap-1">
                        <RoleDialog
                          role={role}
                          trigger={<Button variant="ghost" size="icon"><Pencil className="h-4 w-4" /></Button>}
                          onSaved={refresh}
                        />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete role "{role.name}"?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Users assigned this role will lose its permissions. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => onDelete(role)}>Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                  {role.description && <CardDescription>{role.description}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {role.permissions.length === 0 ? (
                      <span className="text-sm text-muted-foreground">No permissions granted.</span>
                    ) : (
                      role.permissions.map((p) => (
                        <Badge key={grantKey(p.module, p.action)} variant="outline" className="text-xs">
                          {p.module}:{p.action}
                        </Badge>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
