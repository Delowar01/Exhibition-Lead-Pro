import React from "react";
import { useGetOrgHierarchy, OrgHierarchyNode } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

function roleLabel(role?: string) {
  if (!role) return null;
  return role.replace("_", " ");
}

function HierarchyNode({ node, depth }: { node: OrgHierarchyNode; depth: number }) {
  const [open, setOpen] = React.useState(true);
  const hasReports = node.reports && node.reports.length > 0;

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 hover:bg-muted/40 transition-colors"
        style={{ marginLeft: depth * 24 }}
      >
        <button
          type="button"
          className={`text-muted-foreground ${hasReports ? "" : "invisible"}`}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold text-xs shrink-0">
          {node.name?.substring(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{node.name}</span>
            {node.role && <Badge variant="secondary" className="capitalize text-[10px]">{roleLabel(node.role)}</Badge>}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {node.jobTitle ?? node.email ?? ""}
            {node.departmentName ? ` · ${node.departmentName}` : ""}
            {node.teamName ? ` · ${node.teamName}` : ""}
          </div>
        </div>
        {hasReports && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Users className="h-3.5 w-3.5" />{node.reports.length}
          </span>
        )}
      </div>
      {hasReports && open && (
        <div className="space-y-1">
          {node.reports.map((child) => (
            <HierarchyNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminOrgHierarchy() {
  const { data, isLoading } = useGetOrgHierarchy();
  const roots = data?.roots ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Org Hierarchy</h1>
        <p className="text-muted-foreground mt-1">Reporting structure across your organization.</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Reporting Tree</CardTitle>
          <CardDescription>Employees are nested under their reporting manager.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading hierarchy...</div>
          ) : roots.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No reporting structure yet. Assign managers to employees to build the org chart.
            </div>
          ) : (
            <div className="space-y-1">
              {roots.map((node) => (
                <HierarchyNode key={node.id} node={node} depth={0} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
