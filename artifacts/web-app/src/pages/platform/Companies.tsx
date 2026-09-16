import React, { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListCompanies, useCreateCompany, useSuspendCompany, useActivateCompany, getListCompaniesQueryKey, type Company } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader, StatusBadge, TableSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Search, MoreHorizontal, Power, PowerOff, Building2, CreditCard, Plus, ExternalLink } from "lucide-react";
import { SubscriptionManager, STATUSES, PLANS, STATUS_LABEL, CANONICAL_STATUS_LABEL, ACCESS_LABEL, statusTone, accessTone, errMessage, invalidateCompanyQueries } from "@/components/platform/SubscriptionManager";

// Batch 21 — the tenant list of the Platform Owner admin panel. Real, server-side
// paginated data (search / canonical status / plan filters), a row per tenant that
// opens the tenant detail page, a "New company" onboarding dialog (the existing
// POST /companies creates the company and its manual 14-day trial in one
// transaction), confirmed suspend / reactivate (existing lifecycle routes) and
// the shared subscription manager. Loading, empty and error states are explicit;
// no metric on this page is derived or simulated.

const LIMIT = 20;

export default function PlatformCompanies() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [plan, setPlan] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [manageId, setManageId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ company: Company; verb: "suspend" | "activate" } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", plan: "free", industry: "", country: "", primaryContactName: "", primaryContactEmail: "" });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const params = useMemo(
    () => ({ search: search.trim() || undefined, status: status !== "all" ? status : undefined, plan: plan !== "all" ? plan : undefined, page, limit: LIMIT }),
    [search, status, plan, page],
  );
  const list = useListCompanies(params, { query: { queryKey: getListCompaniesQueryKey(params) } });
  const createCompany = useCreateCompany();
  const suspendCompany = useSuspendCompany();
  const activateCompany = useActivateCompany();

  const filtersActive = !!params.search || !!params.status || !!params.plan;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.verb === "suspend") await suspendCompany.mutateAsync({ id: confirm.company.id });
      else await activateCompany.mutateAsync({ id: confirm.company.id });
      toast({ title: confirm.verb === "suspend" ? "Company suspended" : "Company reactivated", description: confirm.company.name });
      invalidateCompanyQueries(queryClient, confirm.company.id);
      setConfirm(null);
    } catch (err) {
      toast({ title: confirm.verb === "suspend" ? "Suspension failed" : "Reactivation failed", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async () => {
    const name = form.name.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await createCompany.mutateAsync({
        data: {
          name,
          plan: form.plan as (typeof PLANS)[number],
          industry: form.industry.trim() || null,
          country: form.country.trim() || null,
          primaryContactName: form.primaryContactName.trim() || null,
          primaryContactEmail: form.primaryContactEmail.trim() || null,
        },
      });
      toast({ title: "Company created", description: `${created.name} starts a manual ${created.subscription?.status === "trialing" ? "trial" : created.subscription?.status ?? "subscription"} on the ${created.subscription?.plan ?? form.plan} plan.` });
      invalidateCompanyQueries(queryClient, created.id);
      setNewOpen(false);
      setForm({ name: "", plan: "free", industry: "", country: "", primaryContactName: "", primaryContactEmail: "" });
      navigate(`/platform/companies/${created.id}`);
    } catch (err) {
      toast({ title: "Company could not be created", description: errMessage(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const subscriptionStatus = (company: Company) => company.subscription?.status;

  return (
    <div className="space-y-6" data-testid="platform-companies">
      <PageHeader
        title="Companies"
        description="Every tenant on the platform with its canonical subscription state. Open a company to manage its profile, subscription, limits and administrators."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/platform/subscriptions"><CreditCard className="mr-2 h-4 w-4" />Subscriptions</Link>
            </Button>
            <Button onClick={() => setNewOpen(true)} data-testid="company-new"><Plus className="mr-2 h-4 w-4" />New company</Button>
          </div>
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <CardTitle>Tenants</CardTitle>
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <div className="relative w-full md:w-72">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search companies..." className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} data-testid="company-search" />
              </div>
              <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]" data-testid="company-status-filter"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={plan} onValueChange={(v) => { setPlan(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]" data-testid="company-plan-filter"><SelectValue placeholder="Plan" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6" data-testid="companies-loading"><TableSkeleton rows={6} /></div>
          ) : list.isError ? (
            <div className="p-6"><ErrorState title="Companies could not be loaded" description={errMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => void list.refetch()} data-testid="companies-retry">Retry</Button>} /></div>
          ) : (list.data?.companies.length ?? 0) === 0 ? (
            <div className="p-6" data-testid="companies-empty">
              <EmptyState
                icon={Building2}
                title={filtersActive ? "No companies match" : "No companies yet"}
                description={filtersActive ? "Adjust the search or filters to see other tenants." : "Create the first tenant to onboard a customer."}
                action={filtersActive ? <Button variant="outline" size="sm" onClick={() => { setSearch(""); setStatus("all"); setPlan("all"); setPage(1); }}>Clear filters</Button> : <Button size="sm" onClick={() => setNewOpen(true)}>New company</Button>}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Contacts</TableHead>
                    <TableHead className="text-right">Scans</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-[50px]"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data?.companies.map((company) => (
                    <TableRow key={company.id} data-testid={`company-row-${company.id}`}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <Link href={`/platform/companies/${company.id}`} className="hover:underline" data-testid={`company-link-${company.id}`}>{company.name}</Link>
                          <span className="text-xs text-muted-foreground font-normal">{company.industry || "No industry"}{company.country ? ` · ${company.country}` : ""}</span>
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{company.subscription?.plan ?? "—"}</Badge></TableCell>
                      <TableCell>
                        <StatusBadge tone={statusTone(subscriptionStatus(company))} showDot>
                          {subscriptionStatus(company) ? CANONICAL_STATUS_LABEL[subscriptionStatus(company)!] ?? subscriptionStatus(company) : "No subscription"}
                        </StatusBadge>
                      </TableCell>
                      <TableCell>
                        {company.subscription ? <StatusBadge tone={accessTone(company.subscription.accessMode)}>{ACCESS_LABEL[company.subscription.accessMode] ?? company.subscription.accessMode}</StatusBadge> : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{company.userCount ?? 0}</TableCell>
                      <TableCell className="text-right tabular-nums">{company.contactCount ?? 0}</TableCell>
                      <TableCell className="text-right tabular-nums">{company.scanCount ?? 0}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{format(new Date(company.createdAt), "MMM d, yyyy")}</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0" data-testid={`company-actions-${company.id}`}>
                              <span className="sr-only">Open menu</span>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/platform/companies/${company.id}`} data-testid={`company-open-${company.id}`}><ExternalLink className="mr-2 h-4 w-4" /> Open company</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!company.subscription} onClick={() => setManageId(company.id)} data-testid={`company-manage-${company.id}`}>
                              <CreditCard className="mr-2 h-4 w-4" /> Manage subscription
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={!company.subscription} onClick={() => setConfirm({ company, verb: subscriptionStatus(company) === "suspended" ? "activate" : "suspend" })} data-testid={`company-toggle-${company.id}`}>
                              {subscriptionStatus(company) === "suspended" ? (
                                <><Power className="mr-2 h-4 w-4" /> Reactivate company</>
                              ) : (
                                <><PowerOff className="mr-2 h-4 w-4" /> Suspend company</>
                              )}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex items-center justify-between p-4 border-t border-border text-sm text-muted-foreground">
            <span data-testid="company-total">{total.toLocaleString()} compan{total === 1 ? "y" : "ies"}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="company-prev">Previous</Button>
              <span data-testid="company-page">Page {page} of {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} data-testid="company-next">Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── New company (onboarding) ─────────────────────────────────────── */}
      <Dialog open={newOpen} onOpenChange={(o) => !busy && setNewOpen(o)}>
        <DialogContent data-testid="new-company-dialog">
          <DialogHeader>
            <DialogTitle>New company</DialogTitle>
            <DialogDescription>Creates the tenant and its manual subscription (14-day trial) in one step. Add the first primary administrator from the company page afterwards.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="new-company-name">Company name</Label>
              <Input id="new-company-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="new-company-name" autoFocus />
            </div>
            <div className="space-y-1">
              <Label>Plan</Label>
              <Select value={form.plan} onValueChange={(v) => setForm({ ...form, plan: v })}>
                <SelectTrigger data-testid="new-company-plan"><SelectValue /></SelectTrigger>
                <SelectContent>{PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-company-industry">Industry</Label>
                <Input id="new-company-industry" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} data-testid="new-company-industry" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-company-country">Country</Label>
                <Input id="new-company-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} data-testid="new-company-country" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-company-contact">Primary contact</Label>
                <Input id="new-company-contact" value={form.primaryContactName} onChange={(e) => setForm({ ...form, primaryContactName: e.target.value })} data-testid="new-company-contact" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-company-contact-email">Contact e-mail</Label>
                <Input id="new-company-contact-email" type="email" value={form.primaryContactEmail} onChange={(e) => setForm({ ...form, primaryContactEmail: e.target.value })} data-testid="new-company-contact-email" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitNew()} disabled={busy || form.name.trim().length < 2} data-testid="new-company-submit">{busy ? "Creating…" : "Create company"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmed suspend / reactivate ───────────────────────────────── */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent data-testid="company-confirm-dialog">
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirm.verb === "suspend" ? `Suspend ${confirm.company.name}?` : `Reactivate ${confirm.company.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm.verb === "suspend"
                    ? "Every user of this company will be blocked from signing in until the suspension is lifted. No data is deleted."
                    : "The suspension is lifted and the company's previous subscription state is restored."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); void runConfirm(); }} disabled={busy} data-testid="company-confirm">{busy ? "Applying…" : confirm.verb === "suspend" ? "Suspend" : "Reactivate"}</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <SubscriptionManager companyId={manageId} onClose={() => setManageId(null)} />
    </div>
  );
}
