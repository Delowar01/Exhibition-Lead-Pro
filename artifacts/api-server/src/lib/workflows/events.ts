import { randomUUID } from "node:crypto";
import type { Contact, Lead } from "@workspace/db";
import { conditionFieldKeys, type EntityRecord } from "./conditions.js";
import type { WorkflowEntity, WorkflowTriggerType } from "./catalog.js";

// =============================================================================
// Workflow events (Batch 16). A CRM mutation is described as one or more events,
// each carrying the POST-mutation entity record (what conditions evaluate
// against), the changed field names, and — for the specific triggers — from/to.
// Built by the CRM services from the rows they already hold; never from HTTP.
// =============================================================================

export interface WorkflowEvent {
  // One id per CRM mutation; every event of that mutation shares it, so the same
  // definition can never produce two runs for one mutation (event_key uniqueness).
  eventId: string;
  companyId: number;
  triggerType: WorkflowTriggerType;
  entityType: WorkflowEntity;
  entityId: number;
  actorUserId: number | null;
  record: EntityRecord;
  changedFields: string[];
  from?: string | null;
  to?: string | null;
}

export function eventKeyOf(e: WorkflowEvent): string {
  return `${e.triggerType}:${e.entityType}:${e.entityId}:${e.eventId}`;
}

// ── Entity records (flat, catalog-field keyed) ──────────────────────────────
export function leadRecord(row: Lead): EntityRecord {
  return {
    stage: row.stage,
    source: row.source ?? null,
    title: row.title ?? null,
    companyName: row.companyName ?? null,
    priority: row.priority ?? null,
    currency: row.currency ?? null,
    value: row.value != null ? Number(row.value) : null,
    probability: row.probability ?? null,
    assignedToId: row.assignedToId ?? null,
    teamId: row.teamId ?? null,
    eventId: row.eventId ?? null,
    organizationId: row.organizationId ?? null,
    contactId: row.contactId ?? null,
    createdById: row.createdById ?? null,
  };
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function contactRecord(row: Contact): EntityRecord {
  return {
    status: row.status,
    leadTemperature: row.leadTemperature ?? null,
    leadScore: row.leadScore ?? null,
    source: row.source ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    fullName: row.fullName ?? null,
    jobTitle: row.jobTitle ?? null,
    contactCompany: row.contactCompany ?? null,
    email: row.email ?? null,
    mobile: row.mobile ?? null,
    country: row.country ?? null,
    city: row.city ?? null,
    industry: row.industry ?? null,
    seniority: row.seniority ?? null,
    tags: parseTags(row.tags),
    assignedToId: row.assignedToId ?? null,
    eventId: row.eventId ?? null,
    organizationId: row.organizationId ?? null,
    createdById: row.createdById ?? null,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export function changedFieldsBetween(entity: WorkflowEntity, before: EntityRecord, after: EntityRecord): string[] {
  return conditionFieldKeys(entity).filter((k) => !sameValue(before[k], after[k]));
}

// ── Event builders ──────────────────────────────────────────────────────────
export function leadCreatedEvent(row: Lead, actorUserId: number | null, eventId = randomUUID()): WorkflowEvent {
  return { eventId, companyId: row.companyId, triggerType: "lead.created", entityType: "lead", entityId: row.id, actorUserId, record: leadRecord(row), changedFields: [] };
}

// A single lead mutation may legitimately emit the generic `lead.updated` plus the
// specific `lead.stage_changed` / `lead.assigned` events. Nothing is emitted when
// no catalog-visible field changed.
export function leadUpdatedEvents(before: Lead, after: Lead, actorUserId: number | null, eventId = randomUUID()): WorkflowEvent[] {
  const b = leadRecord(before);
  const a = leadRecord(after);
  const changedFields = changedFieldsBetween("lead", b, a);
  if (changedFields.length === 0) return [];
  const base = { eventId, companyId: after.companyId, entityType: "lead" as const, entityId: after.id, actorUserId, record: a, changedFields };
  const events: WorkflowEvent[] = [{ ...base, triggerType: "lead.updated" }];
  if (before.stage !== after.stage) events.push({ ...base, triggerType: "lead.stage_changed", from: before.stage, to: after.stage });
  // lead.assigned fires only when the OWNER actually changes (including set/cleared).
  if ((before.assignedToId ?? null) !== (after.assignedToId ?? null)) {
    events.push({
      ...base,
      triggerType: "lead.assigned",
      from: before.assignedToId != null ? String(before.assignedToId) : null,
      to: after.assignedToId != null ? String(after.assignedToId) : null,
    });
  }
  return events;
}

export function contactCreatedEvent(row: Contact, actorUserId: number | null, eventId = randomUUID()): WorkflowEvent {
  return { eventId, companyId: row.companyId, triggerType: "contact.created", entityType: "contact", entityId: row.id, actorUserId, record: contactRecord(row), changedFields: [] };
}

export function contactUpdatedEvents(before: Contact, after: Contact, actorUserId: number | null, eventId = randomUUID()): WorkflowEvent[] {
  const b = contactRecord(before);
  const a = contactRecord(after);
  const changedFields = changedFieldsBetween("contact", b, a);
  if (changedFields.length === 0) return [];
  const base = { eventId, companyId: after.companyId, entityType: "contact" as const, entityId: after.id, actorUserId, record: a, changedFields };
  const events: WorkflowEvent[] = [{ ...base, triggerType: "contact.updated" }];
  if (before.status !== after.status) events.push({ ...base, triggerType: "contact.status_changed", from: before.status, to: after.status });
  return events;
}
