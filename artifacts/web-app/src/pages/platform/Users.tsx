import React, { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useListUsers, useGetCompany, getListUsersQueryKey, getGetCompanyQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, MetricCard, StatusBadge, TableSkeleton, EmptyState, ErrorState } from "@/components/ds";
import { format } from "date-fns";
import { Search, Users, X } from "lucide-react";
import { errMessage } from "@/components/platform/SubscriptionManager";

// Batch 21 — cross-tenant user directory of the Platform Owner admin panel.
// Server-side pagination with the real total, search by name or e-mail, role
// filter, and an optional company filter (`?companyId=`) that the tenant detail
// page links to. Team accounts are administration data (the platform owner
// already manages tenant users); no customer CRM data appears here. Every
// control on this page is functional — no placeholder buttons or derived counts.

const LIMIT = 20;
const ROLES = ["platform_owner", "primary_admin", "admin", "employee"] as const;
const ROLE_LABEL: Record<string, string> = { platform_owner: "Platform owner", primary_admin: "Primary admin", admin: "Admin", employee: "Employee" };

function companyFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get("companyId");
  const id = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function PlatformUsers() {
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const companyId = companyFromSearch(searchString);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [page, setPage] = useState(1);

  const params = useMemo(
    () => ({ search: search.trim() || undefined, role: role !== "all" ? role : undefined, companyId: companyId ?? undefined, page, limit: LIMIT }),
    [search, role, companyId, page],
  );
  const list = useListUsers(params, { query: { queryKey: getListUsersQueryKey(params) } });
  const company = useGetCompany(companyId ?? 0, { query: { enabled: companyId != null, queryKey: getGetCompanyQueryKey(companyId ?? 0) } });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const rows = list.data?.users ?? [];
  const filtersActive = !!params.search || !!params.role || companyId != null;
  const from = total === 0 ? 0 : (page - 1) * LIMIT + 1;
  const to = Math.min(total, (page - 1) * LIMIT + rows.length);

  return (
    <div className="space-y-6" data-testid="platform-users">
      <PageHeader title="Users" description="Every account across all tenants. Open a company to add or manage its administrators." />

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Users matching" value={list.data ? total.toLocaleString() : "…"} icon={Users} footer={filtersActive ? "With the current filters" : "Across all tenants"} />
        {companyId != null && (
          <Card className="md:col-span-2" data-testid="users-company-chip">
            <CardContent className="flex items-center justify-between gap-3 py-4">
              <div className="text-sm">
                <div className="text-muted-foreground">Filtered by company</div>
                <div className="font-medium">
                  {company.data ? <Link href={`/platform/companies/${companyId}`} className="hover:underline">{company.data.name}</Link> : company.isError ? `Company #${companyId}` : "Loading…"}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => { navigate("/platform/users", { replace: true }); setPage(1); }} data-testid="users-company-clear"><X className="mr-1 h-3 w-3" />Clear</Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <CardTitle>Accounts</CardTitle>
            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <div className="relative w-full md:w-80">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search name or e-mail…" className="pl-8" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} data-testid="users-search" />
              </div>
              <Select value={role} onValueChange={(v) => { setRole(v); setPage(1); }}>
                <SelectTrigger className="w-[170px]" data-testid="users-role-filter"><SelectValue placeholder="Role" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6"><TableSkeleton rows={6} /></div>
          ) : list.isError ? (
            <div className="p-6"><ErrorState title="Users could not be loaded" description={errMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => void list.refetch()}>Retry</Button>} /></div>
          ) : rows.length === 0 ? (
            <div className="p-6"><EmptyState icon={Users} title="No users match" description={filtersActive ? "Adjust the search, role or company filter." : "Accounts appear once tenants are onboarded."} /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-secondary/30">
                  <TableRow>
                    <TableHead className="pl-6">User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((user) => (
                    <TableRow key={user.id} className="hover:bg-muted/30" data-testid={`user-row-${user.id}`}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center font-semibold text-xs border border-border">
                            {user.name.substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-medium text-sm">{user.name}</div>
                            <div className="text-xs text-muted-foreground">{user.email}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === "platform_owner" ? "default" : user.role === "primary_admin" ? "secondary" : "outline"}>{ROLE_LABEL[user.role] ?? user.role}</Badge>
                      </TableCell>
                      <TableCell>
                        {user.companyId ? (
                          <Link href={`/platform/companies/${user.companyId}`} className="text-sm font-medium hover:underline" data-testid={`user-company-${user.id}`}>{user.companyName ?? `Company #${user.companyId}`}</Link>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Platform</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={user.isActive ? "success" : "neutral"} showDot>{user.isActive ? "Active" : "Disabled"}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">{format(new Date(user.createdAt), "MMM d, yyyy")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border text-sm text-muted-foreground">
            <span data-testid="users-total">{list.data ? `Showing ${from}–${to} of ${total.toLocaleString()} user${total === 1 ? "" : "s"}` : "Loading…"}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="users-prev">Previous</Button>
              <span>Page {page} of {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} data-testid="users-next">Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
