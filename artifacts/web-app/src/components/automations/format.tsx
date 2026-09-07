import { format, formatDistanceToNowStrict } from "date-fns";
import { StatusBadge, type StatusTone } from "@/components/ds";
import type { Catalog, WorkflowEntity } from "./catalog";

// ── definition status (Draft / Active / Archived) ───────────────────────────

export const DEFINITION_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  published: "Active",
  archived: "Archived",
};

const DEFINITION_STATUS_TONE: Record<string, StatusTone> = {
  draft: "warning",
  published: "success",
  archived: "neutral",
};

export function definitionStatusLabel(status: string, catalog?: Catalog): string {
  return catalog?.lifecycle?.[status]?.label ?? DEFINITION_STATUS_LABEL[status] ?? humanize(status);
}

export function DefinitionStatusBadge({ status, catalog, className }: { status: string; catalog?: Catalog; className?: string }) {
  return (
    <StatusBadge tone={DEFINITION_STATUS_TONE[status] ?? "neutral"} className={className}>
      {definitionStatusLabel(status, catalog)}
    </StatusBadge>
  );
}

// ── run / action status ─────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<string, StatusTone> = {
  queued: "info",
  running: "primary",
  completed: "success",
  failed: "destructive",
  pending: "neutral",
  skipped: "warning",
};

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <StatusBadge tone={RUN_STATUS_TONE[status] ?? "neutral"} className={className}>
      {humanize(status)}
    </StatusBadge>
  );
}

export function isActiveRunStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

// ── labels ──────────────────────────────────────────────────────────────────

export function humanize(key: string | null | undefined): string {
  if (!key) return "";
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function triggerLabel(catalog: Catalog | undefined, type: string | null | undefined): string {
  return catalog?.triggers.find((t) => t.type === type)?.label ?? humanize(type ?? "");
}

export function actionLabel(catalog: Catalog | undefined, type: string | null | undefined): string {
  return catalog?.actions.find((a) => a.type === type)?.label ?? humanize(type ?? "");
}

/** Catalog descriptions end with an API mapping ("Maps to POST /tasks.") meant for API consumers; hide it in the UI. */
export function userFacing(description: string | null | undefined): string {
  if (!description) return "";
  return description.replace(/\s*Maps to [^.]*\.?\s*$/i, "").trim();
}

export function entityLabel(entity: WorkflowEntity | string | null | undefined): string {
  return entity === "lead" ? "Lead" : entity === "contact" ? "Contact" : humanize(entity ?? "");
}

export function entityHref(entity: string | null | undefined, id: number | null | undefined): string | null {
  if (id == null) return null;
  if (entity === "lead") return `/admin/leads/${id}`;
  if (entity === "contact") return `/admin/contacts/${id}`;
  return null;
}

// ── dates ───────────────────────────────────────────────────────────────────

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return format(d, "d MMM yyyy, HH:mm");
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function durationBetween(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Render a sanitized result/error object as readable key/value pairs (never raw JSON dumps of unknown depth). */
export function safeEntries(obj: unknown): Array<[string, string]> {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}
