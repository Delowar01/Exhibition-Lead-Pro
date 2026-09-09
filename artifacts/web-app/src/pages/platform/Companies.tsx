import React, { useState } from "react";
import { Link } from "wouter";
import { useListCompanies, useSuspendCompany, useActivateCompany, getListCompaniesQueryKey, type Company } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { Search, MoreHorizontal, Power, PowerOff, Building2, CreditCard } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

export default function PlatformCompanies() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [plan, setPlan] = useState<string>("all");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListCompanies({
    search: search || undefined,
    status: status !== "all" ? status : undefined,
    plan: plan !== "all" ? plan : undefined,
    limit: 50,
  });

  const suspendCompany = useSuspendCompany();
  const activateCompany = useActivateCompany();

  // Batch 20: suspend/reactivate operate on the canonical subscription
  // (POST /companies/:id/suspend|activate → lifecycle service). Suspension is
  // allowed from any non-suspended state; "Activate" reactivates a suspended
  // company (restoring the pre-suspension state) or activates a manual one.
  const handleStatusChange = (id: number, currentStatus: string | undefined) => {
    if (currentStatus && currentStatus !== "suspended") {
      suspendCompany.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Company suspended" });
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
        }
      });
    } else {
      activateCompany.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Company reactivated" });
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
        }
      });
    }
  };

  const getStatusBadgeVariant = (status: string | undefined) => {
    switch (status) {
      case "active":
      case "trialing":
        return "default";
      case "suspended":
      case "expired":
        return "destructive";
      case "cancelled":
      case "past_due":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getPlanBadgeVariant = (plan: string | undefined) => {
    switch (plan) {
      case "enterprise": return "default";
      case "business":
      case "professional": return "secondary";
      default: return "outline";
    }
  };

  const subscriptionStatus = (company: Company) => company.subscription?.status;
  const subscriptionPlan = (company: Company) => company.subscription?.plan;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between" data-testid="platform-companies">
        <h1 className="text-3xl font-bold tracking-tight">Companies</h1>
        <Button asChild variant="outline">
          <Link href="/platform/subscriptions">
            <CreditCard className="mr-2 h-4 w-4" />
            Subscriptions
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <div className="relative w-full md:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search companies..." 
                className="pl-8" 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="trialing">Trialing</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="past_due">Past due</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Plans</SelectItem>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead className="text-right">Scans</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading companies...</TableCell>
                  </TableRow>
                ) : data?.companies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No companies found.</TableCell>
                  </TableRow>
                ) : (
                  data?.companies.map((company) => (
                    <TableRow key={company.id} data-testid={`company-row-${company.id}`}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{company.name}</span>
                          <span className="text-xs text-muted-foreground font-normal">{company.industry || "No industry"}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getPlanBadgeVariant(subscriptionPlan(company))} className="capitalize">
                          {subscriptionPlan(company) ?? "—"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(subscriptionStatus(company))} className="capitalize">
                          {subscriptionStatus(company)?.replace("_", " ") ?? "No subscription"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{company.userCount}</TableCell>
                      <TableCell className="text-right">{company.scanCount}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(company.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                              <span className="sr-only">Open menu</span>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href="/platform/subscriptions">
                                <CreditCard className="mr-2 h-4 w-4" /> Manage subscription
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!company.subscription}
                              onClick={() => handleStatusChange(company.id, subscriptionStatus(company))}
                            >
                              {subscriptionStatus(company) === "suspended" ? (
                                <><Power className="mr-2 h-4 w-4" /> Reactivate Company</>
                              ) : (
                                <><PowerOff className="mr-2 h-4 w-4" /> Suspend Company</>
                              )}
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
    </div>
  );
}
