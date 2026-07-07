import { useState } from "react";
import { Contact, DollarSign, Plus, Search, TrendingUp, Users } from "lucide-react";
import {
  PageHeader,
  StatusBadge,
  MetricCard,
  EmptyState,
  ErrorState,
  TableSkeleton,
  CardGridSkeleton,
  SectionTitle,
  Caption,
  OverlineLabel,
} from "@/components/ds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const TOKEN_SWATCHES = [
  { name: "primary", cls: "bg-primary" },
  { name: "primary-soft", cls: "bg-primary-soft" },
  { name: "success", cls: "bg-success" },
  { name: "success-soft", cls: "bg-success-soft" },
  { name: "warning", cls: "bg-warning" },
  { name: "warning-soft", cls: "bg-warning-soft" },
  { name: "info", cls: "bg-info" },
  { name: "info-soft", cls: "bg-info-soft" },
  { name: "destructive", cls: "bg-destructive" },
  { name: "destructive-soft", cls: "bg-destructive-soft" },
  { name: "brand-navy", cls: "bg-brand-navy" },
  { name: "muted", cls: "bg-muted" },
];

/**
 * Internal Design System showcase (Stage 5.9 Phase 1).
 * Living reference for tokens, typography, and the enterprise component layer.
 */
export default function DesignSystem() {
  const [showSkeletons, setShowSkeletons] = useState(false);

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Design System" }]}
        title="Enterprise Design System"
        description="Stage 5.9 foundation — tokens, typography, and the shared component layer. Every future screen builds only from these pieces."
        actions={
          <>
            <Button variant="outline">
              <Search className="h-4 w-4 mr-2" aria-hidden="true" />
              Secondary
            </Button>
            <Button>
              <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
              Primary action
            </Button>
          </>
        }
      />

      <div className="space-y-10">
        <section>
          <SectionTitle>Color tokens</SectionTitle>
          <Caption className="mb-3">Semantic tokens only — no raw hex values in feature code. All tokens have light + dark values.</Caption>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {TOKEN_SWATCHES.map((s) => (
              <div key={s.name} className="rounded-lg border border-card-border bg-card p-2">
                <div className={`h-10 rounded-md border border-border ${s.cls}`} />
                <p className="mt-1.5 text-xs font-medium text-foreground truncate">{s.name}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle>Typography hierarchy</SectionTitle>
          <div className="mt-3 rounded-lg border border-card-border bg-card p-5 space-y-3">
            <p className="text-4xl font-bold tracking-tight">Display / 36</p>
            <p className="text-2xl font-bold tracking-tight">Page title / 24</p>
            <p className="text-lg font-semibold">Section title / 18</p>
            <p className="text-sm font-semibold">Subsection / 14 semibold</p>
            <p className="text-sm">Body / 14 — the default reading size across the product.</p>
            <p className="text-xs text-muted-foreground">Caption / 12 muted — helper and meta text.</p>
            <OverlineLabel>Overline label / 11 uppercase</OverlineLabel>
            <p className="text-3xl font-bold tabular-nums tracking-tight">1,248 <span className="text-sm font-normal text-muted-foreground">KPI number / tabular</span></p>
          </div>
        </section>

        <section>
          <SectionTitle>Metric cards</SectionTitle>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Total Contacts" value="4,382" delta={12} deltaLabel="vs last month" icon={Contact} />
            <MetricCard label="Open Leads" value="317" delta={-4} deltaLabel="vs last month" icon={Users} />
            <MetricCard label="Pipeline Value" value="$1.2M" delta={8} icon={DollarSign} />
            <MetricCard label="Win Rate" value="34%" icon={TrendingUp} footer="Deterministic — from CRM data" />
          </div>
        </section>

        <section>
          <SectionTitle>Status badges</SectionTitle>
          <Caption className="mb-3">One badge, six tones — leading dot keeps state readable for colorblind users.</Caption>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="success">Won</StatusBadge>
            <StatusBadge tone="warning">Pending</StatusBadge>
            <StatusBadge tone="info">In review</StatusBadge>
            <StatusBadge tone="destructive">Lost</StatusBadge>
            <StatusBadge tone="primary">Hot lead</StatusBadge>
            <StatusBadge tone="neutral">Archived</StatusBadge>
          </div>
        </section>

        <section>
          <SectionTitle>States — empty, error, skeleton</SectionTitle>
          <div className="mt-3 flex items-center gap-2 mb-3">
            <Switch id="ds-skel" checked={showSkeletons} onCheckedChange={setShowSkeletons} />
            <Label htmlFor="ds-skel">Show loading skeletons</Label>
          </div>
          {showSkeletons ? (
            <div className="space-y-4">
              <CardGridSkeleton />
              <TableSkeleton rows={4} />
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <EmptyState
                title="No contacts yet"
                description="Scan a business card or add a contact manually to get started."
                action={<Button size="sm"><Plus className="h-4 w-4 mr-1" aria-hidden="true" />Add contact</Button>}
              />
              <ErrorState
                description="We couldn't load this list. Check your connection and try again."
                action={<Button size="sm" variant="outline">Retry</Button>}
              />
            </div>
          )}
        </section>

        <section>
          <SectionTitle>Forms & inputs</SectionTitle>
          <div className="mt-3 rounded-lg border border-card-border bg-card p-5 max-w-md space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ds-name">Full name</Label>
              <Input id="ds-name" placeholder="Jane Cooper" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-email">Work email</Label>
              <Input id="ds-email" type="email" placeholder="jane@company.com" aria-describedby="ds-email-hint" />
              <p id="ds-email-hint" className="text-xs text-muted-foreground">Every input gets a visible label — placeholders are never the only identifier.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline">Cancel</Button>
              <Button>Save changes</Button>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle>Tabs & table</SectionTitle>
          <Tabs defaultValue="active" className="mt-3">
            <TabsList>
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
            <TabsContent value="active">
              <div className="rounded-lg border border-card-border bg-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">Acme Corp expansion</TableCell>
                      <TableCell><StatusBadge tone="info">Qualified</StatusBadge></TableCell>
                      <TableCell className="text-right tabular-nums">$48,000</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium">Nexus renewal</TableCell>
                      <TableCell><StatusBadge tone="success">Won</StatusBadge></TableCell>
                      <TableCell className="text-right tabular-nums">$12,500</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="all">
              <EmptyState title="Nothing here" description="Switch back to the Active tab." />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
