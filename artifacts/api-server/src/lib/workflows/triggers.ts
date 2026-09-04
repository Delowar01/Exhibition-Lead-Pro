import type { WorkflowEvent } from "./events.js";

// =============================================================================
// Pure trigger-config evaluation (Batch 16). Mirrors the B15 trigger catalog:
//   lead.updated / contact.updated   `fields` (optional): at least one configured
//                                    field must be among the changed fields
//   lead.stage_changed               `fromStageKey` / `toStageKey` (optional)
//   contact.status_changed           `fromStatus` / `toStatus` (optional)
//   lead.created / lead.assigned / contact.created   no config
// An event whose trigger type differs from the definition's never matches.
// =============================================================================

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function matchesTriggerConfig(definitionTriggerType: string, config: Record<string, unknown> | null | undefined, event: WorkflowEvent): boolean {
  if (definitionTriggerType !== event.triggerType) return false;
  const cfg = config ?? {};
  switch (event.triggerType) {
    case "lead.updated":
    case "contact.updated": {
      const fields = Array.isArray(cfg.fields) ? cfg.fields.filter((f): f is string => typeof f === "string") : [];
      if (fields.length === 0) return true;
      return fields.some((f) => event.changedFields.includes(f));
    }
    case "lead.stage_changed": {
      const from = optString(cfg.fromStageKey);
      const to = optString(cfg.toStageKey);
      if (from !== undefined && (event.from ?? null) !== from) return false;
      if (to !== undefined && (event.to ?? null) !== to) return false;
      return true;
    }
    case "contact.status_changed": {
      const from = optString(cfg.fromStatus);
      const to = optString(cfg.toStatus);
      if (from !== undefined && (event.from ?? null) !== from) return false;
      if (to !== undefined && (event.to ?? null) !== to) return false;
      return true;
    }
    case "lead.created":
    case "lead.assigned":
    case "contact.created":
      return true;
  }
}
