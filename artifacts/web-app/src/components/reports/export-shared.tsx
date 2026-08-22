import React from "react";
import {
  useListEvents,
  useListUsers,
  useListPipelineStages,
  ContactStatus,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Shared building blocks for the Reports & Export Center workspace. The filter
// keys rendered here are exactly the ones the export backend applies
// (export.service.ts fetchContacts/fetchLeads) — no invented filters.

export type ExportEntity = "contact" | "lead";
export type ExportFileFormat = "csv" | "excel" | "pdf" | "json";

export const FORMAT_OPTIONS: { value: ExportFileFormat; label: string; hint: string }[] = [
  { value: "csv", label: "CSV", hint: "Comma-separated, opens in any spreadsheet" },
  { value: "excel", label: "Excel", hint: "Native .xlsx workbook" },
  { value: "pdf", label: "PDF", hint: "Printable table document" },
  { value: "json", label: "JSON", hint: "Structured data for developers" },
];

export type FilterValues = Record<string, string>;

/** Drop empty / "all" sentinel values so only real filters reach the API. */
export function cleanFilters(filters: Record<string, string | undefined>): FilterValues {
  const out: FilterValues = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v != null && v !== "" && v !== "all") out[k] = v;
  }
  return out;
}

export function humanFileSize(bytes?: number | null): string {
  if (bytes == null || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function formatStatusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Navigate to a server-issued signed URL (never constructed client-side). */
export function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function FilterSelect({
  label,
  value,
  onChange,
  placeholder,
  children,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || "all"} onValueChange={onChange}>
        <SelectTrigger className="h-9" data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{placeholder}</SelectItem>
          {children}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Entity-specific export filter fields, matching the backend contract:
 *   contact → search, status, temperature, eventId, assignedToId, dateFrom, dateTo
 *   lead    → stage, eventId, assignedToId
 */
export function ExportFilterFields({
  entityType,
  value,
  onChange,
}: {
  entityType: ExportEntity;
  value: FilterValues;
  onChange: (next: FilterValues) => void;
}) {
  const { data: eventsData } = useListEvents({ limit: 100 });
  const { data: usersData } = useListUsers();
  const { data: stagesData } = useListPipelineStages();

  const events = eventsData?.events ?? [];
  const users = usersData?.users ?? [];
  const stages = [...(stagesData?.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

  const set = (key: string, v: string) => {
    const next = { ...value };
    if (!v || v === "all") delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {entityType === "contact" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <Input
            className="h-9"
            placeholder="Name, email, company…"
            value={value.search ?? ""}
            onChange={(e) => set("search", e.target.value)}
            data-testid="export-filter-search"
          />
        </div>
      )}

      {entityType === "contact" && (
        <FilterSelect label="Status" value={value.status ?? "all"} onChange={(v) => set("status", v)} placeholder="All statuses" testId="export-filter-status">
          {Object.values(ContactStatus).map((s) => (
            <SelectItem key={s} value={s}>
              {formatStatusLabel(s)}
            </SelectItem>
          ))}
        </FilterSelect>
      )}

      {entityType === "contact" && (
        <FilterSelect label="Temperature" value={value.temperature ?? "all"} onChange={(v) => set("temperature", v)} placeholder="All temperatures">
          <SelectItem value="hot">Hot</SelectItem>
          <SelectItem value="warm">Warm</SelectItem>
          <SelectItem value="cold">Cold</SelectItem>
        </FilterSelect>
      )}

      {entityType === "lead" && (
        <FilterSelect label="Stage" value={value.stage ?? "all"} onChange={(v) => set("stage", v)} placeholder="All stages" testId="export-filter-stage">
          {stages.map((s) => (
            <SelectItem key={s.key} value={s.key}>
              {s.name}
            </SelectItem>
          ))}
        </FilterSelect>
      )}

      <FilterSelect label="Event" value={value.eventId ?? "all"} onChange={(v) => set("eventId", v)} placeholder="All events" testId="export-filter-event">
        {events.map((e) => (
          <SelectItem key={e.id} value={String(e.id)}>
            {e.name}
          </SelectItem>
        ))}
      </FilterSelect>

      <FilterSelect label="Assigned to" value={value.assignedToId ?? "all"} onChange={(v) => set("assignedToId", v)} placeholder="Anyone">
        {users.map((u) => (
          <SelectItem key={u.id} value={String(u.id)}>
            {u.name}
          </SelectItem>
        ))}
      </FilterSelect>

      {entityType === "contact" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Date from</Label>
          <Input
            className="h-9"
            type="date"
            value={value.dateFrom ?? ""}
            onChange={(e) => set("dateFrom", e.target.value)}
          />
        </div>
      )}

      {entityType === "contact" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Date to</Label>
          <Input
            className="h-9"
            type="date"
            value={value.dateTo ?? ""}
            onChange={(e) => set("dateTo", e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
