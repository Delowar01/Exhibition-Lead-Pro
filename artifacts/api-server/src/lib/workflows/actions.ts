import { db, notificationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { Contact, Lead } from "@workspace/db";
import type { AuthUser } from "../../middlewares/requireAuth.js";
import type { Executor } from "../../repositories/base.js";
import * as leadsService from "../../services/leads.service.js";
import * as contactsService from "../../services/contacts.service.js";
import * as contactsRepo from "../../repositories/contacts.repository.js";
import { createTask } from "../../services/tasks.service.js";
import { createFollowUp } from "../../services/follow-ups.service.js";
import { createNotification } from "../../services/notifications.service.js";
import { sendNotificationEmail } from "../email/index.js";
import { refInCompany } from "../tenant.js";
import { WorkflowFailure, WorkflowSkip } from "./errors.js";
import { recordContact, resolveEmailRecipient, resolveUserRecipient, type RecipientConfig, type RecipientContext } from "./recipients.js";
import type { WorkflowActionType, WorkflowEntity } from "./catalog.js";

// =============================================================================
// Action executors (Batch 16) — one per B15 action type, each mapped onto the
// EXISTING CRM service (never the HTTP API, never a parallel implementation of
// the business rules). Every executor runs with the run's tenant-pinned system
// principal, inside the workflow context (loop safety), and receives the freshly
// re-loaded entity of the run's own company.
//
// Outcomes: resolve → completed (sanitized `result`), throw WorkflowSkip →
// skipped, throw WorkflowFailure/AppError → deterministic failure, anything
// else → transient (queue retry). Executors that create rows commit the row AND
// the action's completion in one transaction via ctx.transactional, so an
// at-least-once re-delivery can never duplicate the side effect.
// =============================================================================

export interface ActionContext {
  runId: number;
  companyId: number;
  actorUserId: number | null;
  principal: AuthUser;
  entityType: WorkflowEntity;
  entityId: number;
  lead?: Lead;
  contact?: Contact;
  actionIndex: number;
  // Stable per-action idempotency key: `wf:<runId>:<actionIndex>`.
  idempotencyKey: string;
  // Runs `fn` in a DB transaction and marks the action completed (with the
  // returned result) inside the SAME transaction.
  transactional: <T extends Record<string, unknown>>(fn: (tx: Executor) => Promise<T>) => Promise<T>;
}

export type ActionResult = Record<string, unknown>;
export type ActionExecutor = (config: Record<string, unknown>, ctx: ActionContext) => Promise<ActionResult>;

function recipientCtx(ctx: ActionContext): RecipientContext {
  return { companyId: ctx.companyId, actorUserId: ctx.actorUserId, entityType: ctx.entityType, lead: ctx.lead, contact: ctx.contact };
}

function requireLead(ctx: ActionContext): Lead {
  if (!ctx.lead) throw new WorkflowFailure("ENTITY_MISMATCH", "action requires a lead entity");
  return ctx.lead;
}

function requireContact(ctx: ActionContext): Contact {
  if (!ctx.contact) throw new WorkflowFailure("ENTITY_MISMATCH", "action requires a contact entity");
  return ctx.contact;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function dateInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

function entityLink(ctx: ActionContext): string {
  return ctx.entityType === "lead" ? `/admin/leads/${ctx.entityId}` : `/admin/contacts/${ctx.entityId}`;
}

// ── lead actions ────────────────────────────────────────────────────────────
const leadAssignOwner: ActionExecutor = async (config, ctx) => {
  const lead = requireLead(ctx);
  const strategy = (str(config.strategy) ?? "manual") as "manual" | "round_robin" | "load_balanced" | "availability" | "territory";
  if (!["manual", "round_robin", "load_balanced", "availability", "territory"].includes(strategy)) {
    throw new WorkflowFailure("INVALID_CONFIG", `unsupported assignment strategy "${strategy}"`); // "ai" is never allowed
  }
  const assignedToId = num(config.assignedToId);
  const teamId = num(config.teamId);
  if (strategy === "manual") {
    if (assignedToId == null) throw new WorkflowFailure("INVALID_CONFIG", "assignedToId is required for manual assignment");
    if (!(await refInCompany("users", ctx.companyId, assignedToId))) throw new WorkflowFailure("REFERENCE_INVALID", `configured user #${assignedToId} is not a member of this company`);
  }
  if (teamId != null && !(await refInCompany("teams", ctx.companyId, teamId))) throw new WorkflowFailure("REFERENCE_INVALID", `configured team #${teamId} does not exist in this company`);
  // Idempotent: already owned by the configured user → nothing to do.
  if (strategy === "manual" && lead.assignedToId === assignedToId && (teamId == null || lead.teamId === teamId)) {
    return { assignedToId, unchanged: true };
  }
  const updated = await leadsService.assignLead(ctx.principal, lead.id, { strategy, assignedToId, teamId });
  return { assignedToId: updated.assignedToId ?? null, teamId: updated.teamId ?? null, strategy };
};

const leadUpdateFields: ActionExecutor = async (config, ctx) => {
  const lead = requireLead(ctx);
  const fields = (config.fields ?? {}) as Record<string, unknown>;
  if (typeof fields !== "object" || fields === null || Object.keys(fields).length === 0) throw new WorkflowFailure("INVALID_CONFIG", "fields is required");
  // (existence of a configured stage key is verified by updateLead itself — an
  // unknown key raises AppError 400 → deterministic failure, nothing is written)
  for (const [table, key] of [["teams", "teamId"], ["events", "eventId"], ["organizations", "organizationId"]] as const) {
    const id = num(fields[key]);
    if (id != null && !(await refInCompany(table, ctx.companyId, id))) throw new WorkflowFailure("REFERENCE_INVALID", `configured ${key} #${id} does not exist in this company`);
  }
  const r = await leadsService.updateLead(ctx.principal, lead.id, fields as leadsService.LeadInput);
  if (r.conflict) throw new WorkflowFailure("BUSINESS_RULE", `lead cannot be reopened: contact already has open lead #${r.existingId}`);
  return { fields: Object.keys(fields) };
};

const leadAddTag: ActionExecutor = async (config, ctx) => {
  const lead = requireLead(ctx);
  const tagId = num(config.tagId);
  if (tagId == null) throw new WorkflowFailure("INVALID_CONFIG", "tagId is required");
  if (!(await refInCompany("tags", ctx.companyId, tagId))) throw new WorkflowFailure("REFERENCE_INVALID", `configured tag #${tagId} no longer exists in this company`);
  await leadsService.attachLeadTag(ctx.principal, lead.id, { tagId }); // ON CONFLICT DO NOTHING → idempotent
  return { tagId };
};

const leadRemoveTag: ActionExecutor = async (config, ctx) => {
  const lead = requireLead(ctx);
  const tagId = num(config.tagId);
  if (tagId == null) throw new WorkflowFailure("INVALID_CONFIG", "tagId is required");
  if (!(await refInCompany("tags", ctx.companyId, tagId))) throw new WorkflowFailure("REFERENCE_INVALID", `configured tag #${tagId} no longer exists in this company`);
  await leadsService.detachLeadTag(ctx.principal, lead.id, tagId); // idempotent
  return { tagId };
};

// ── contact actions ─────────────────────────────────────────────────────────
const contactUpdateFields: ActionExecutor = async (config, ctx) => {
  const contact = requireContact(ctx);
  const fields = (config.fields ?? {}) as Record<string, unknown>;
  if (typeof fields !== "object" || fields === null || Object.keys(fields).length === 0) throw new WorkflowFailure("INVALID_CONFIG", "fields is required");
  for (const [table, key] of [["events", "eventId"], ["organizations", "organizationId"]] as const) {
    const id = num(fields[key]);
    if (id != null && !(await refInCompany(table, ctx.companyId, id))) throw new WorkflowFailure("REFERENCE_INVALID", `configured ${key} #${id} does not exist in this company`);
  }
  const { leadTemperature, ...rest } = fields;
  if (Object.keys(rest).length > 0) {
    await contactsService.updateContact(ctx.principal, contact.id, rest as contactsService.UpdateContactInput);
  }
  // leadTemperature is not part of the PATCH /contacts contract (the AI scorer sets
  // it); the catalog exposes it, so it is written as a plain column on the already
  // tenant-verified contact row.
  if (typeof leadTemperature === "string") {
    await contactsRepo.update(contact.id, { leadTemperature });
  }
  return { fields: Object.keys(fields) };
};

const contactAssignOwner: ActionExecutor = async (config, ctx) => {
  const contact = requireContact(ctx);
  const assignedToId = num(config.assignedToId);
  if (assignedToId == null) throw new WorkflowFailure("INVALID_CONFIG", "assignedToId is required");
  if (!(await refInCompany("users", ctx.companyId, assignedToId))) throw new WorkflowFailure("REFERENCE_INVALID", `configured user #${assignedToId} is not a member of this company`);
  if (contact.assignedToId === assignedToId) return { assignedToId, unchanged: true };
  await contactsService.updateContact(ctx.principal, contact.id, { assignedToId });
  return { assignedToId };
};

const contactAddTag: ActionExecutor = async (config, ctx) => {
  const contact = requireContact(ctx);
  const tag = str(config.tag)?.trim();
  if (!tag) throw new WorkflowFailure("INVALID_CONFIG", "tag is required");
  const tags = parseTags(contact.tags);
  if (tags.includes(tag)) return { tag, unchanged: true };
  await contactsService.updateContact(ctx.principal, contact.id, { tags: [...tags, tag] });
  return { tag };
};

const contactRemoveTag: ActionExecutor = async (config, ctx) => {
  const contact = requireContact(ctx);
  const tag = str(config.tag)?.trim();
  if (!tag) throw new WorkflowFailure("INVALID_CONFIG", "tag is required");
  const tags = parseTags(contact.tags);
  if (!tags.includes(tag)) return { tag, unchanged: true };
  await contactsService.updateContact(ctx.principal, contact.id, { tags: tags.filter((t) => t !== tag) });
  return { tag };
};

// ── task / follow-up / notification / email ─────────────────────────────────
function recipientConfig(v: unknown, field: string): RecipientConfig {
  if (typeof v !== "object" || v === null || typeof (v as { kind?: unknown }).kind !== "string") {
    throw new WorkflowFailure("INVALID_CONFIG", `${field} is required`);
  }
  const r = v as { kind: string; userId?: unknown };
  return { kind: r.kind as RecipientConfig["kind"], userId: num(r.userId) };
}

const taskCreate: ActionExecutor = async (config, ctx) => {
  const title = str(config.title)?.trim();
  if (!title) throw new WorkflowFailure("INVALID_CONFIG", "title is required");
  const assignee = await resolveUserRecipient(recipientConfig(config.assignee, "assignee"), recipientCtx(ctx));
  const contact = await recordContact(recipientCtx(ctx));
  const dueInDays = num(config.dueInDays);
  return ctx.transactional(async (tx) => {
    const row = await createTask(
      ctx.principal,
      {
        title,
        type: str(config.type) ?? "custom",
        notes: str(config.notes) ?? null,
        contactId: contact?.id ?? null,
        dueDate: dueInDays != null ? dateInDays(dueInDays) : null,
        dueTime: str(config.dueTime) ?? null,
        assignedToId: assignee.id,
      },
      tx,
    );
    return { taskId: row.id, assignedToId: row.assignedToId, linkedContact: row.contactId != null };
  });
};

const followUpCreate: ActionExecutor = async (config, ctx) => {
  const contact = await recordContact(recipientCtx(ctx));
  if (!contact) throw new WorkflowSkip("record has no contact to follow up with");
  const scheduleInDays = num(config.scheduleInDays);
  if (scheduleInDays == null) throw new WorkflowFailure("INVALID_CONFIG", "scheduleInDays is required");
  const assignee = config.assignee != null ? await resolveUserRecipient(recipientConfig(config.assignee, "assignee"), recipientCtx(ctx)) : null;
  return ctx.transactional(async (tx) => {
    const row = await createFollowUp(
      ctx.principal,
      {
        contactId: contact.id,
        scheduledDate: dateInDays(scheduleInDays),
        scheduledTime: str(config.scheduledTime) ?? null,
        notes: str(config.notes) ?? null,
        assignedToId: assignee?.id ?? null,
      },
      tx,
    );
    return { followUpId: row.id, contactId: row.contactId, scheduledDate: row.scheduledDate, assignedToId: row.assignedToId };
  });
};

const notificationCreate: ActionExecutor = async (config, ctx) => {
  const title = str(config.title)?.trim();
  if (!title) throw new WorkflowFailure("INVALID_CONFIG", "title is required");
  const recipient = await resolveUserRecipient(recipientConfig(config.recipient, "recipient"), recipientCtx(ctx));
  // Idempotent on retry: the notification row carries the action key in its metadata.
  const [existing] = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, recipient.id), sql`${notificationsTable.metadata} ->> 'workflowActionKey' = ${ctx.idempotencyKey}`))
    .limit(1);
  if (existing) return { notificationId: existing.id, recipientUserId: recipient.id, unchanged: true };
  const row = await createNotification({
    userId: recipient.id,
    companyId: ctx.companyId,
    category: "workflows",
    title,
    body: str(config.body) ?? null,
    link: entityLink(ctx),
    metadata: { workflowRunId: ctx.runId, actionIndex: ctx.actionIndex, workflowActionKey: ctx.idempotencyKey, entityType: ctx.entityType, entityId: ctx.entityId },
    emailDedupeKey: `${ctx.idempotencyKey}:email`,
  });
  return { notificationId: row?.id ?? null, recipientUserId: recipient.id, inApp: row != null };
};

const emailSend: ActionExecutor = async (config, ctx) => {
  const subject = str(config.subject)?.trim();
  const body = str(config.body)?.trim();
  if (!subject || !body) throw new WorkflowFailure("INVALID_CONFIG", "subject and body are required");
  const to = await resolveEmailRecipient(recipientConfig(config.to, "to"), recipientCtx(ctx));
  // Existing queued email path (SMTP provider configured on the platform; nothing
  // provider-related lives in the definition). The queue dedupe key makes a retried
  // action a no-op instead of a second email.
  const result = await sendNotificationEmail({ to: to.email, title: subject, body }, { dedupeKey: `${ctx.idempotencyKey}:email` });
  return { queued: result.queued === true, sent: result.sent, recipientKind: (config.to as { kind: string }).kind, recipientUserId: to.userId };
};

export const ACTION_EXECUTORS: Record<WorkflowActionType, ActionExecutor> = {
  "lead.assign_owner": leadAssignOwner,
  "lead.update_fields": leadUpdateFields,
  "lead.add_tag": leadAddTag,
  "lead.remove_tag": leadRemoveTag,
  "contact.update_fields": contactUpdateFields,
  "contact.assign_owner": contactAssignOwner,
  "contact.add_tag": contactAddTag,
  "contact.remove_tag": contactRemoveTag,
  "task.create": taskCreate,
  "follow_up.create": followUpCreate,
  "notification.create": notificationCreate,
  "email.send": emailSend,
};
