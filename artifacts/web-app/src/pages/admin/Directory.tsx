import React from "react";
import {
  useListEmployeeDirectory,
  useListDepartments,
  useListTeams,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Users } from "lucide-react";

const ANY = "all";

const EMPLOYMENT_STATUSES = [
  { value: "active", label: "Active" },
  { value: "probation", label: "Probation" },
  { value: "on_leave", label: "On Leave" },
  { value: "suspended", label: "Suspended" },
  { value: "offboarded", label: "Offboarded" },
];

function statusVariant(status?: string): "default" | "secondary" | "destructive" {
  if (status === "active") return "default";
  if (status === "suspended" || status === "offboarded") return "destructive";
  return "secondary";
}

export default function AdminDirectory() {
  const [search, setSearch] = React.useState("");
  const [deptFilter, setDeptFilter] = React.useState(ANY);
  const [teamFilter, setTeamFilter] = React.useState(ANY);
  const [statusFilter, setStatusFilter] = React.useState(ANY);

  const { data: deptData } = useListDepartments({ status: "active", limit: 100 });
  const { data: teamData } = useListTeams({ limit: 100 });
  const departments = deptData?.departments ?? [];
  const teams = teamData?.teams ?? [];

  const { data, isLoading } = useListEmployeeDirectory({
    search: search.trim() || undefined,
    departmentId: deptFilter === ANY ? undefined : Number(deptFilter),
    teamId: teamFilter === ANY ? undefined : Number(teamFilter),
    employmentStatus: statusFilter === ANY ? undefined : statusFilter,
    sort: "name",
    order: "asc",
    limit: 200,
  });
  const employees = data?.users ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Employee Directory</h1>
        <p className="text-muted-foreground mt-1">Browse and filter everyone across your organization.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border mb-4">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Directory</CardTitle>
                <CardDescription>{data?.total ?? 0} employees</CardDescription>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <Input
                placeholder="Search name, email, title..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select value={deptFilter} onValueChange={setDeptFilter}>
                <SelectTrigger><SelectValue placeholder="Department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All Departments</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={teamFilter} onValueChange={setTeamFilter}>
                <SelectTrigger><SelectValue placeholder="Team" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All Teams</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All Statuses</SelectItem>
                  {EMPLOYMENT_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
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
                  <TableHead>Employee</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Manager</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">Loading directory...</TableCell></TableRow>
                ) : employees.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No employees match your filters.</TableCell></TableRow>
                ) : (
                  employees.map((u) => (
                    <TableRow key={u.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold text-xs">
                            {u.name?.substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="font-medium">{u.name}</div>
                            <div className="text-xs text-muted-foreground">{u.email}{u.employeeId ? ` · ${u.employeeId}` : ""}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.jobTitle ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.departmentName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.teamName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.managerName ?? "—"}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant={statusVariant(u.employmentStatus)} className="capitalize">
                          {(u.employmentStatus ?? "active").replace("_", " ")}
                        </Badge>
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
