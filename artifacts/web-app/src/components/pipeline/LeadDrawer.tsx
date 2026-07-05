import { Link } from "wouter";
import {
  Mail,
  Building2,
  CalendarClock,
  Users,
  User as UserIcon,
  Tag as TagIcon,
  ExternalLink,
  Sparkles,
  Activity,
  BellRing,
} from "lucide-react";
import { parseISO, format } from "date-fns";
import { useGetLead, type PipelineStageConfig } from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StageBadge } from "./StageBadge";
import {
  BRAND,
  companyName,
  displayName,
  formatMoney,
  PRIORITY_META,
  type StageMap,
} from "./utils";

interface LeadDrawerProps {
  leadId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stageMap: StageMap;
  stages: PipelineStageConfig[];
}

function Row({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-0.5 text-sm">{children}</div>
      </div>
    </div>
  );
}

function DrawerBody({ leadId, stageMap, stages }: { leadId: number; stageMap: StageMap; stages: PipelineStageConfig[] }) {
  const { data: lead, isLoading } = useGetLead(leadId);

  if (isLoading || !lead) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const company = companyName(lead);
  const money = formatMoney(lead.value, lead.currency);
  const pr = lead.priority ? PRIORITY_META[lead.priority] : null;
  const closing = lead.closingDate ? format(parseISO(lead.closingDate), "MMM d, yyyy") : null;

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b px-6 pb-4" style={{ borderColor: `${BRAND.navy}1a` }}>
        <SheetTitle className="text-xl" style={{ color: BRAND.navy }}>
          <span className="dark:text-foreground">{displayName(lead)}</span>
        </SheetTitle>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <StageBadge lead={lead} stageMap={stageMap} stages={stages} size="md" />
          {pr && <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${pr.badge}`}>{pr.label} priority</span>}
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto px-6 py-2">
        <div
          className="my-4 rounded-xl border p-4"
          style={{ borderColor: `${BRAND.orange}33`, backgroundColor: BRAND.orangeSoft }}
        >
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Deal value</div>
          <div className="mt-1 text-2xl font-bold" style={{ color: BRAND.navy }}>
            <span className="dark:text-foreground">{money ?? "\u2014"}</span>
            {lead.probability != null && (
              <span className="ml-2 text-sm font-medium text-muted-foreground">{lead.probability}% probability</span>
            )}
          </div>
        </div>

        <div className="divide-y">
          {lead.contactEmail && (
            <Row icon={Mail} label="Email">
              <a href={`mailto:${lead.contactEmail}`} className="hover:underline" style={{ color: BRAND.orange }}>
                {lead.contactEmail}
              </a>
            </Row>
          )}
          {company && (
            <Row icon={Building2} label="Company">
              {company}
            </Row>
          )}
          <Row icon={UserIcon} label="Owner">
            {lead.assignedToName || <span className="text-muted-foreground">Unassigned</span>}
          </Row>
          <Row icon={Users} label="Team">
            {lead.teamName || <span className="text-muted-foreground">No team</span>}
          </Row>
          {lead.eventName && (
            <Row icon={CalendarClock} label="Event">
              {lead.eventName}
            </Row>
          )}
          <Row icon={CalendarClock} label="Expected close">
            {closing || <span className="text-muted-foreground">{"\u2014"}</span>}
          </Row>
          <Row icon={Sparkles} label="AI lead score">
            <span className="text-muted-foreground">{"\u2014"}</span>
          </Row>
          <Row icon={Activity} label="Last activity">
            <span className="text-muted-foreground">{"\u2014"}</span>
          </Row>
          <Row icon={BellRing} label="Next follow-up">
            <span className="text-muted-foreground">{"\u2014"}</span>
          </Row>
          {(lead.tags ?? []).length > 0 && (
            <Row icon={TagIcon} label="Tags">
              <div className="flex flex-wrap gap-1.5">
                {(lead.tags ?? []).map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full border px-2 py-0.5 text-xs"
                    style={{ borderColor: `${t.color || BRAND.navy300}55`, color: t.color || BRAND.navy }}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            </Row>
          )}
          {lead.notes && (
            <div className="py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Notes</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{lead.notes}</p>
            </div>
          )}
        </div>
      </div>

      <div className="border-t p-4" style={{ borderColor: `${BRAND.navy}1a` }}>
        <Link href={`/admin/leads/${lead.id}`}>
          <Button
            data-testid="button-open-full-record"
            className="w-full text-white hover:opacity-90"
            style={{ backgroundColor: BRAND.navy }}
          >
            Open full record
            <ExternalLink className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}

export function LeadDrawer({ leadId, open, onOpenChange, stageMap, stages }: LeadDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md" data-testid="lead-drawer">
        {leadId != null && <DrawerBody leadId={leadId} stageMap={stageMap} stages={stages} />}
      </SheetContent>
    </Sheet>
  );
}
