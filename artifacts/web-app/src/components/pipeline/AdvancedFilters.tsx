import type {
  User,
  Team,
  Event as CrmEvent,
  Tag,
  PipelineStageConfig,
} from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type LeadFilters, type StatusFilter } from "./utils";

const ALL = "__all__";

interface AdvancedFiltersProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: LeadFilters;
  onChange: (patch: Partial<LeadFilters>) => void;
  onReset: () => void;
  stages: PipelineStageConfig[];
  users: User[];
  teams: Team[];
  events: CrmEvent[];
  tags: Tag[];
}

export function AdvancedFilters({
  open,
  onOpenChange,
  filters,
  onChange,
  onReset,
  stages,
  users,
  teams,
  events,
  tags,
}: AdvancedFiltersProps) {
  const toggleStage = (key: string) => {
    const has = filters.stages.includes(key);
    onChange({ stages: has ? filters.stages.filter((s) => s !== key) : [...filters.stages, key] });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-sm" data-testid="advanced-filters">
        <SheetHeader className="border-b pb-4">
          <SheetTitle>
            Advanced filters
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto py-5">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Status</Label>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "open", "won", "lost"] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`filter-status-${s}`}
                  onClick={() => onChange({ status: s })}
                  className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                    filters.status === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Stages</Label>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((s) => {
                const active = filters.stages.includes(s.key);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleStage(s.key)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                      active ? "bg-muted" : "hover:bg-muted border-border"
                    }`}
                    style={active ? { borderColor: s.color || "var(--color-primary)" } : {}}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color || "var(--color-muted-foreground)" }} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Owner</Label>
            <Select
              value={filters.ownerId != null ? String(filters.ownerId) : ALL}
              onValueChange={(v) => onChange({ ownerId: v === ALL ? null : parseInt(v, 10) })}
            >
              <SelectTrigger data-testid="filter-owner"><SelectValue placeholder="Any owner" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any owner</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Team</Label>
            <Select
              value={filters.teamId != null ? String(filters.teamId) : ALL}
              onValueChange={(v) => onChange({ teamId: v === ALL ? null : parseInt(v, 10) })}
            >
              <SelectTrigger data-testid="filter-team"><SelectValue placeholder="Any team" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any team</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Event</Label>
            <Select
              value={filters.eventId != null ? String(filters.eventId) : ALL}
              onValueChange={(v) => onChange({ eventId: v === ALL ? null : parseInt(v, 10) })}
            >
              <SelectTrigger data-testid="filter-event"><SelectValue placeholder="Any event" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any event</SelectItem>
                {events.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Priority</Label>
            <Select
              value={filters.priority ?? ALL}
              onValueChange={(v) => onChange({ priority: v === ALL ? null : v })}
            >
              <SelectTrigger data-testid="filter-priority"><SelectValue placeholder="Any priority" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any priority</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {tags.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Tag</Label>
              <Select
                value={filters.tagId != null ? String(filters.tagId) : ALL}
                onValueChange={(v) => onChange({ tagId: v === ALL ? null : parseInt(v, 10) })}
              >
                <SelectTrigger data-testid="filter-tag"><SelectValue placeholder="Any tag" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any tag</SelectItem>
                  {tags.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Deal value range</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Min"
                data-testid="filter-min-value"
                value={filters.minValue ?? ""}
                onChange={(e) => onChange({ minValue: e.target.value === "" ? null : Number(e.target.value) })}
              />
              <span className="text-muted-foreground">to</span>
              <Input
                type="number"
                placeholder="Max"
                data-testid="filter-max-value"
                value={filters.maxValue ?? ""}
                onChange={(e) => onChange({ maxValue: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row gap-2 border-t pt-4">
          <Button variant="outline" className="flex-1" onClick={onReset} data-testid="button-reset-filters">
            Reset
          </Button>
          <Button
            className="flex-1"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
