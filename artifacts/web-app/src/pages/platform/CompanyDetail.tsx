import React, { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCompany,
  useUpdateCompany,
  useDeleteCompany,
  useSuspendCompany,
  useActivateCompany,
  useCreateUser,
  useListUsers,
  useListCompanyAudit,
  usePlatformGetSubscription,
  getGetCompanyQueryKey,
  getListUsersQueryKey,
  getListCompanyAuditQueryKey,
  getPlatformGetSubscriptionQueryKey,
  ApiError,
  type Company,
  type CompanyAuditEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader, StatusBadge, TableSkeleton, CardGridSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Building2, CreditCard, Pencil, Power, PowerOff, Trash2, UserPlus, Users, ShieldCheck } from "lucide-react";
import { SubscriptionManager, CANONICAL_STATUS_LABEL, ACCESS_LABEL, ACTION_LABEL, statusTone, accessTone, fmt, fmtDateTime, errMessage, invalidateCompanyQueries } from "@/components/platform/SubscriptionManager";

// Batch 21 — the tenant detail page of the Platform Owner admin panel. One
// place per company for: the canonical subscription (state, access, trial /
// period, usage against effective limits) with the shared lifecycle manager,
// the company profile (editable), the tenant's administrators and members
// (team administration — never CRM data), the administrative audit trail, and
// the destructive actions behind explicit confirmation. Every read and every
// mutation goes through the existing platform-owner routes.

const PROFILE_FIELDS: Array<{ key: keyof ProfileForm; label: string; type?: string }> = [
  { key: "name", label: "Company name" },
  { key: "legalName", label: "Legal name" },
  { key: "registrationNumber", label: "Registration number" },
  { key: "vatNumber", label: "VAT number" },
  { key: "industry", label: "Industry" },
  { key: "country", label: "Country" },
  { key: "address", label: "Address" },
  { key: "website", label: "Website" },
  { key: "timezone", label: "Timezone" },
  { key: "currency", label: "Currency" },
  { key: "primaryContactName", label: "Primary contact" },
  { key: "primaryContactEmail", label: "Primary contact e-mail", type: "email" },
];
type ProfileForm = { name: string; legalName: string; registrationNumber: string; vatNumber: string; industry: string; country: string; address: string; website: string; timezone: string; currency: string; primaryContactName: string; primaryContactEmail: string };
const emptyForm = (): ProfileForm => ({ name: "", legalName: "", registrationNumber: "", vatNumber: "", industry: "", country: "", address: "", website: "", timezone: "", currency: "", primaryContactName: "", primaryContactEmail: "" });
const formFromCompany = (c: Company): ProfileForm => ({
  name: c.name ?? "",
  legalName: c.legalName ?? "",
  registrationNumber: c.registrationNumber ?? "",
  vatNumber: c.vatNumber ?? "",
  industry: c.industry ?? "",
  country: c.country ?? "",
  address: c.address ?? "",
  website: c.website ?? "",
  timezone: c.timezone ?? "",
  currency: c.currency ?? "",
  primaryContactName: c.primaryContactName ?? "",
  primaryContactEmail: c.primaryContactEmail ?? "",
});

const ROLE_LABEL: Record<string, string> = { platform_owner: "Platform owner", primary_admin: "Primary admin", admin: "Admin", employee: "Employee" };

// Initial password for a tenant administrator, generated in the browser (never
// stored by the panel) and shown exactly once after the account is created.
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += alphabet[b % alphabet.length];
  return `${body.slice(0, 7)}-${body.slice(7)}A7!`;
}

const AUDIT_ACTION_LABEL: Record<string, string> = {
  "subscription.create": "Subscription created",
  "subscription.set_plan": "Plan changed",
  "subscription.start_trial": "Trial started / extended",
  "subscription.activate": "Activated",
  "subscription.mark_past_due": "Marked past due",
  "subscription.cancel": "Cancelled",
  "subscription.expire": "Expired",
  "subscription.suspend": "Suspended",
  "subscription.reactivate": "Suspension lifted",
  "subscription.set_limits": "Limit overrides changed",
  "subscription.convert_to_manual": "Converted to manual billing",
  "subscription.sweep_expire_trial": "Trial expired (scheduled sweep)",
  "subscription.provider_sync": "Provider sync",
  "subscription.repair_create": "Repair: subscription created",
  "subscription.repair_update": "Repair: subscription normalised",
  "company.post": "Company request",
  "company.patch": "Company profile updated",
  "company.put": "Company branding updated",
  "company.delete": "Company deleted",
  "team.account_created": "Administrator account created",
  "team.post": "Team member created",
  "team.patch": "Team member updated",
  "team.put": "Team roles changed",
  "team.delete": "Team member removed",
};

function auditSummary(e: CompanyAuditEntry): string {
  const md = (e.metadata ?? {}) as Record<string, any>;
  const parts: string[] = [];
  if (md.before && md.after) {
    const keys = ["status", "plan", "billingSource"] as const;
    for (const k of keys) if (md.before[k] !== undefined && md.after[k] !== undefined && md.before[k] !== md.after[k]) parts.push(`${k} ${md.before[k]} → ${md.after[k]}`);
  }
  if (md.reason) parts.push(`reason: ${md.reason}`);
  if (md.limits && typeof md.limits === "object") parts.push(`limits ${Object.entries(md.limits).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(", ") || "cleared"}`);
  if (md.trialDays) parts.push(`${md.trialDays} days`);
  if (md.role) parts.push(`role: ${ROLE_LABEL[String(md.role)] ?? String(md.role)}${md.createdByPlatform ? " (by the platform)" : ""}`);
  if (!parts.length && md.path) parts.push(`${md.method ?? ""} ${String(md.path).replace(/^\/api/, "")}`.trim());
  return parts.join(" · ");
}

export default function PlatformCompanyDetail() {
  const params = useParams<{ id: string }>();
  const id = Number.parseInt(params.id ?? "", 10);
  const valid = Number.isInteger(id) && id > 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const company = useGetCompany(id, { query: { enabled: valid, queryKey: getGetCompanyQueryKey(id) } });
  const subscription = usePlatformGetSubscription(id, { query: { enabled: valid, queryKey: getPlatformGetSubscriptionQueryKey(id) } });
  const usersParams = useMemo(() => ({ companyId: id, limit: 100 }), [id]);
  const users = useListUsers(usersParams, { query: { enabled: valid, queryKey: getListUsersQueryKey(usersParams) } });
  const audit = useListCompanyAudit(id, { query: { enabled: valid, queryKey: getListCompanyAuditQueryKey(id) } });

  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const suspendCompany = useSuspendCompany();
  const activateCompany = useActivateCompany();
  const createUser = useCreateUser();

  const [manageOpen, setManageOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<ProfileForm>(emptyForm());
  const [confirm, setConfirm] = useState<"suspend" | "activate" | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminForm, setAdminForm] = useState({ name: "", email: "", password: "" });
  const [adminCreated, setAdminCreated] = useState<{ email: string; password: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [busy, setBusy] = useState(false);

  const c = company.data;
  const sub = subscription.data;
  const status = c?.subscription?.status;
  const notFound = company.isError && company.error instanceof ApiError && company.error.status === 404;

  const refresh = () => invalidateCompanyQueries(queryClient, id);

  const openEdit = () => {
    if (c) setForm(formFromCompany(c));
    setEditOpen(true);
  };
  const submitEdit = async () => {
    if (!c) return;
    setBusy(true);
    try {
      const nz = (v: string) => (v.trim() === "" ? null : v.trim());
      await updateCompany.mutateAsync({
        id,
        data: {
          name: form.name.trim() || c.name,
          legalName: nz(form.legalName),
          registrationNumber: nz(form.registrationNumber),
          vatNumber: nz(form.vatNumber),
          industry: nz(form.industry),
          country: nz(form.country),
          address: nz(form.address),
          website: nz(form.website),
          timezone: nz(form.timezone),
          currency: nz(form.currency),
          primaryContactName: nz(form.primaryContactName),
          primaryContactEmail: nz(form.primaryContactEmail),
        },
      });
      toast({ title: "Profile updated" });
      refresh();
      setEditOpen(false);
    } catch (err) {
      toast({ title: "Profile update failed", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm || !c) return;
    setBusy(true);
    try {
      if (confirm === "suspend") await suspendCompany.mutateAsync({ id });
      else await activateCompany.mutateAsync({ id });
      toast({ title: confirm === "suspend" ? "Company suspended" : "Company reactivated", description: c.name });
      refresh();
      setConfirm(null);
    } catch (err) {
      toast({ title: confirm === "suspend" ? "Suspension failed" : "Reactivation failed", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const openAdmin = () => {
    setAdminForm({ name: "", email: "", password: generatePassword() });
    setAdminCreated(null);
    setAdminOpen(true);
  };
  const submitAdmin = async () => {
    const name = adminForm.name.trim();
    const email = adminForm.email.trim().toLowerCase();
    if (!name || !email || adminForm.password.length < 8) return;
    setBusy(true);
    try {
      await createUser.mutateAsync({ data: { name, email, role: "primary_admin", companyId: id, password: adminForm.password } });
      toast({ title: "Primary administrator created", description: email });
      setAdminCreated({ email, password: adminForm.password });
      setAdminForm({ name: "", email: "", password: "" });
      void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
      refresh();
    } catch (err) {
      toast({ title: "Administrator could not be created", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!c || deleteName.trim() !== c.name) return;
    setBusy(true);
    try {
      await deleteCompany.mutateAsync({ id });
      toast({ title: "Company deleted", description: `${c.name} and all of its data were removed.` });
      invalidateCompanyQueries(queryClient);
      navigate("/platform/companies", { replace: true });
    } catch (err) {
      toast({ title: "Deletion failed", description: errMessage(err), variant: "destructive" });
      setBusy(false);
    }
  };

  if (!valid) {
    return (
      <div className="space-y-6" data-testid="company-detail-invalid">
        <PageHeader title="Company" breadcrumbs={[{ label: "Companies", href: "/platform/companies" }, { label: "Not found" }]} />
        <ErrorState title="Invalid company reference" description="The address does not point to a company." action={<Button asChild variant="outline"><Link href="/platform/companies">Back to companies</Link></Button>} />
      </div>
    );
  }
  if (company.isLoading) {
    return (
      <div className="space-y-6" data-testid="company-detail-loading">
        <PageHeader title="Loading company…" breadcrumbs={[{ label: "Companies", href: "/platform/companies" }, { label: "…" }]} />
        <CardGridSkeleton cards={3} />
        <TableSkeleton rows={4} />
      </div>
    );
  }
  if (company.isError || !c) {
    return (
      <div className="space-y-6" data-testid="company-detail-error">
        <PageHeader title="Company" breadcrumbs={[{ label: "Companies", href: "/platform/companies" }, { label: notFound ? "Not found" : "Error" }]} />
        <ErrorState
          title={notFound ? "Company not found" : "Company could not be loaded"}
          description={notFound ? "It may have been deleted, or the reference is wrong." : errMessage(company.error)}
          action={
            <div className="flex gap-2">
              {!notFound && <Button variant="outline" size="sm" onClick={() => void company.refetch()} data-testid="company-detail-retry">Retry</Button>}
              <Button asChild variant="outline" size="sm"><Link href="/platform/companies">Back to companies</Link></Button>
            </div>
          }
        />
      </div>
    );
  }

  const memberRows = users.data?.users ?? [];
  const admins = memberRows.filter((u) => u.role === "primary_admin" || u.role === "admin").length;
  const activeMembers = memberRows.filter((u) => u.isActive).length;

  return (
    <div className="space-y-6" data-testid="company-detail">
      <PageHeader
        title={c.name}
        description={[c.industry, c.country, `Created ${format(new Date(c.createdAt), "MMM d, yyyy")}`].filter(Boolean).join(" · ")}
        breadcrumbs={[{ label: "Companies", href: "/platform/companies" }, { label: c.name }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={openEdit} data-testid="detail-edit"><Pencil className="mr-2 h-4 w-4" />Edit profile</Button>
            <Button variant="outline" onClick={() => setManageOpen(true)} disabled={!c.subscription} data-testid="detail-manage-subscription"><CreditCard className="mr-2 h-4 w-4" />Manage subscription</Button>
            {status === "suspended" ? (
              <Button onClick={() => setConfirm("activate")} data-testid="detail-toggle-status"><Power className="mr-2 h-4 w-4" />Reactivate</Button>
            ) : (
              <Button variant="destructive" onClick={() => setConfirm("suspend")} disabled={!c.subscription} data-testid="detail-toggle-status"><PowerOff className="mr-2 h-4 w-4" />Suspend</Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Subscription ─────────────────────────────────────────────── */}
          <Card data-testid="detail-subscription">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Subscription</CardTitle>
                  <CardDescription>Canonical state — the single record that decides this tenant's access.</CardDescription>
                </div>
                {c.subscription && (
                  <div className="flex flex-wrap gap-2 justify-end">
                    <StatusBadge tone={statusTone(c.subscription.status)} showDot><span data-testid="detail-status">{CANONICAL_STATUS_LABEL[c.subscription.status] ?? c.subscription.status}</span></StatusBadge>
                    <StatusBadge tone={accessTone(c.subscription.accessMode)}><span data-testid="detail-access">{ACCESS_LABEL[c.subscription.accessMode] ?? c.subscription.accessMode}</span></StatusBadge>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!c.subscription ? (
                <ErrorState title="No canonical subscription" description="This company has no subscription row; access is blocked until the repair command creates one." />
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-3 text-sm">
                    <div><span className="text-muted-foreground">Plan</span><div className="capitalize font-medium" data-testid="detail-plan">{c.subscription.plan}</div></div>
                    <div><span className="text-muted-foreground">Billing</span><div className="capitalize">{c.subscription.billingSource === "stripe" ? "Stripe-managed" : "Manual (platform)"}</div></div>
                    <div><span className="text-muted-foreground">{c.subscription.status === "trialing" ? "Trial ends" : "Period ends"}</span><div>{fmt(c.subscription.status === "trialing" ? c.subscription.trialExpiresAt : c.subscription.currentPeriodEndsAt ?? c.subscription.trialExpiresAt)}{c.subscription.cancelAtPeriodEnd ? " (cancels)" : ""}</div></div>
                    {c.subscription.message && <div className="sm:col-span-3 text-muted-foreground" data-testid="detail-access-message">{c.subscription.message}</div>}
                    {sub?.suspendedReason && <div className="sm:col-span-3"><span className="text-muted-foreground">Suspension reason</span><div>{sub.suspendedReason}</div></div>}
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-2">Usage and effective limits</div>
                    {subscription.isLoading ? (
                      <TableSkeleton rows={3} />
                    ) : subscription.isError ? (
                      <ErrorState title="Usage unavailable" description={errMessage(subscription.error)} action={<Button variant="outline" size="sm" onClick={() => void subscription.refetch()}>Retry</Button>} />
                    ) : sub ? (
                      <div className="overflow-x-auto" data-testid="detail-usage">
                        <Table>
                          <TableHeader>
                            <TableRow><TableHead>Resource</TableHead><TableHead className="text-right">Used</TableHead><TableHead className="text-right">Limit</TableHead><TableHead>Source</TableHead></TableRow>
                          </TableHeader>
                          <TableBody>
                            {sub.usage.resources.map((r) => (
                              <TableRow key={r.resource} data-testid={`detail-usage-${r.resource}`}>
                                <TableCell className="capitalize">{r.resource}</TableCell>
                                <TableCell className="text-right tabular-nums">{r.measurable ? r.used : "n/a"}</TableCell>
                                <TableCell className="text-right tabular-nums">{r.limit == null ? "Unlimited" : r.limit}</TableCell>
                                <TableCell className="text-muted-foreground">{r.source}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : null}
                  </div>
                  {sub && (
                    <div className="text-xs text-muted-foreground" data-testid="detail-allowed-actions">
                      Available actions: {sub.allowedActions.length ? sub.allowedActions.map((a) => ACTION_LABEL[a] ?? a).join(", ") : "none"}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* ── Team administration ───────────────────────────────────────── */}
          <Card data-testid="detail-users">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Administrators and members</CardTitle>
                  <CardDescription>{users.data ? `${users.data.total} account${users.data.total === 1 ? "" : "s"} · ${admins} admin${admins === 1 ? "" : "s"} · ${activeMembers} active` : "Team accounts of this tenant."}</CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm"><Link href={`/platform/users?companyId=${id}`} data-testid="detail-users-link"><Users className="mr-2 h-4 w-4" />All users</Link></Button>
                  <Button size="sm" onClick={openAdmin} data-testid="detail-add-admin"><UserPlus className="mr-2 h-4 w-4" />Add primary admin</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {users.isLoading ? (
                <div className="p-6"><TableSkeleton rows={3} /></div>
              ) : users.isError ? (
                <div className="p-6"><ErrorState title="Team could not be loaded" description={errMessage(users.error)} action={<Button variant="outline" size="sm" onClick={() => void users.refetch()}>Retry</Button>} /></div>
              ) : memberRows.length === 0 ? (
                <div className="p-6"><EmptyState icon={ShieldCheck} title="No accounts yet" description="Create the first primary administrator so the tenant can sign in." action={<Button size="sm" onClick={openAdmin}>Add primary admin</Button>} /></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Account</TableHead><TableHead>Joined</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {memberRows.map((u) => (
                        <TableRow key={u.id} data-testid={`user-row-${u.id}`}>
                          <TableCell>
                            <div className="font-medium text-sm">{u.name}</div>
                            <div className="text-xs text-muted-foreground">{u.email}</div>
                          </TableCell>
                          <TableCell><Badge variant={u.role === "primary_admin" ? "default" : "outline"}>{ROLE_LABEL[u.role] ?? u.role}</Badge></TableCell>
                          <TableCell><StatusBadge tone={u.isActive ? "success" : "neutral"} showDot>{u.isActive ? "Active" : "Disabled"}</StatusBadge></TableCell>
                          <TableCell className="text-sm text-muted-foreground">{format(new Date(u.createdAt), "MMM d, yyyy")}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Administrative audit trail ────────────────────────────────── */}
          <Card data-testid="detail-audit">
            <CardHeader>
              <CardTitle>Administrative activity</CardTitle>
              <CardDescription>Subscription lifecycle, profile and team-administration entries{audit.data ? ` — ${audit.data.total} total, latest ${Math.min(audit.data.total, audit.data.limit)} shown` : ""}. Customer CRM activity is never listed here.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {audit.isLoading ? (
                <div className="p-6"><TableSkeleton rows={3} /></div>
              ) : audit.isError ? (
                <div className="p-6"><ErrorState title="Activity could not be loaded" description={errMessage(audit.error)} action={<Button variant="outline" size="sm" onClick={() => void audit.refetch()}>Retry</Button>} /></div>
              ) : (audit.data?.items.length ?? 0) === 0 ? (
                <div className="p-6"><EmptyState icon={Building2} title="No administrative activity" description="Lifecycle and profile changes appear here as they happen." /></div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>When</TableHead><TableHead>Action</TableHead><TableHead>By</TableHead><TableHead>Details</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.data?.items.map((e) => (
                        <TableRow key={e.id} data-testid={`audit-row-${e.id}`}>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{fmtDateTime(e.createdAt)}</TableCell>
                          <TableCell className="text-sm"><span data-testid="audit-action">{AUDIT_ACTION_LABEL[e.action] ?? e.action}</span></TableCell>
                          <TableCell className="text-sm text-muted-foreground">{e.userName ?? "system"}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{auditSummary(e) || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* ── Profile ───────────────────────────────────────────────────── */}
          <Card data-testid="detail-profile">
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Company record maintained by the platform.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm">
                {PROFILE_FIELDS.filter((f) => f.key !== "name").map((f) => (
                  <div key={f.key} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="break-words" data-testid={`profile-${f.key}`}>{(c[f.key] as string | null | undefined) || "—"}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* ── Tenant footprint (aggregate counts only) ──────────────────── */}
          <Card data-testid="detail-counts">
            <CardHeader>
              <CardTitle>Footprint</CardTitle>
              <CardDescription>Aggregate counts only — customer records are never shown to the platform.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-3 gap-3 text-center">
                <div><dt className="text-xs text-muted-foreground">Users</dt><dd className="text-xl font-semibold tabular-nums" data-testid="count-users">{c.userCount ?? 0}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Contacts</dt><dd className="text-xl font-semibold tabular-nums" data-testid="count-contacts">{c.contactCount ?? 0}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Scans</dt><dd className="text-xl font-semibold tabular-nums" data-testid="count-scans">{c.scanCount ?? 0}</dd></div>
              </dl>
            </CardContent>
          </Card>

          {/* ── Danger zone ───────────────────────────────────────────────── */}
          <Card className="border-destructive/40" data-testid="detail-danger">
            <CardHeader>
              <CardTitle className="text-destructive">Danger zone</CardTitle>
              <CardDescription>Deleting a company permanently removes the tenant, its users and all of its data. Suspending keeps everything and blocks sign-in instead.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => { setDeleteName(""); setDeleteOpen(true); }} data-testid="detail-delete"><Trash2 className="mr-2 h-4 w-4" />Delete company</Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <SubscriptionManager companyId={manageOpen ? id : null} onClose={() => setManageOpen(false)} />

      {/* ── Edit profile ─────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => !busy && setEditOpen(o)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="edit-dialog">
          <DialogHeader>
            <DialogTitle>Edit profile</DialogTitle>
            <DialogDescription>Plan and status are not edited here — use the subscription manager, which keeps the lifecycle transactional and audited.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {PROFILE_FIELDS.map((f) => (
              <div key={f.key} className={`space-y-1 ${f.key === "name" || f.key === "address" ? "sm:col-span-2" : ""}`}>
                <Label htmlFor={`edit-${f.key}`}>{f.label}</Label>
                <Input id={`edit-${f.key}`} type={f.type ?? "text"} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} data-testid={`edit-${f.key}`} />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitEdit()} disabled={busy || form.name.trim().length < 2} data-testid="edit-submit">{busy ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add primary admin ────────────────────────────────────────────── */}
      <Dialog open={adminOpen} onOpenChange={(o) => !busy && (setAdminOpen(o), !o && setAdminCreated(null))}>
        <DialogContent data-testid="add-admin-dialog">
          <DialogHeader>
            <DialogTitle>Add primary administrator</DialogTitle>
            <DialogDescription>Creates a primary admin account for {c.name}. The initial password is generated here and shown once — hand it over securely; the administrator can change it after signing in.</DialogDescription>
          </DialogHeader>
          {adminCreated ? (
            <div className="space-y-3 text-sm" data-testid="add-admin-created">
              <p>The account <strong>{adminCreated.email}</strong> can sign in now. Initial password (shown once):</p>
              <code className="block rounded bg-muted px-3 py-2 font-mono text-sm break-all" data-testid="add-admin-created-password">{adminCreated.password}</code>
              <DialogFooter>
                <Button onClick={() => { setAdminOpen(false); setAdminCreated(null); }} data-testid="add-admin-done">Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="grid gap-3">
                <div className="space-y-1">
                  <Label htmlFor="admin-name">Name</Label>
                  <Input id="admin-name" value={adminForm.name} onChange={(e) => setAdminForm({ ...adminForm, name: e.target.value })} data-testid="add-admin-name" autoFocus />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="admin-email">Work e-mail</Label>
                  <Input id="admin-email" type="email" value={adminForm.email} onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })} data-testid="add-admin-email" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="admin-password">Initial password</Label>
                  <div className="flex gap-2">
                    <Input id="admin-password" value={adminForm.password} onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })} className="font-mono" data-testid="add-admin-password" />
                    <Button type="button" variant="outline" onClick={() => setAdminForm({ ...adminForm, password: generatePassword() })} data-testid="add-admin-generate">Generate</Button>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAdminOpen(false)} disabled={busy}>Cancel</Button>
                <Button onClick={() => void submitAdmin()} disabled={busy || !adminForm.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminForm.email.trim()) || adminForm.password.length < 8} data-testid="add-admin-submit">{busy ? "Creating…" : "Create administrator"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirmed suspend / reactivate ───────────────────────────────── */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent data-testid="company-confirm-dialog">
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirm === "suspend" ? `Suspend ${c.name}?` : `Reactivate ${c.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm === "suspend"
                    ? "Every user of this company will be blocked from signing in until the suspension is lifted. No data is deleted."
                    : "The suspension is lifted and the company's previous subscription state is restored."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); void runConfirm(); }} disabled={busy} data-testid="company-confirm">{busy ? "Applying…" : confirm === "suspend" ? "Suspend" : "Reactivate"}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete (type the name) ───────────────────────────────────────── */}
      <AlertDialog open={deleteOpen} onOpenChange={(o) => !o && !busy && setDeleteOpen(false)}>
        <AlertDialogContent data-testid="delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {c.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the company, its subscription, every user account and all customer data. It cannot be undone. Type the company name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="delete-confirm-name">Company name</Label>
            <Input id="delete-confirm-name" value={deleteName} onChange={(e) => setDeleteName(e.target.value)} placeholder={c.name} data-testid="delete-confirm-name" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void submitDelete(); }} disabled={busy || deleteName.trim() !== c.name} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="delete-confirm">{busy ? "Deleting…" : "Delete permanently"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
