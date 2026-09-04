import { z } from "zod/v4";

// =============================================================================
// Workflow automation catalog (Batch 15 — Workflow Definitions).
// =============================================================================
// The SINGLE source of truth for what a workflow definition may contain:
//   trigger types → entity + config schema
//   condition fields (per entity) → type + allowed operators
//   condition operators → value shape
//   action types → compatible entities + config schema + tenant references
//
// It is consumed by:
//   • API validation (lib/workflows/definition.ts + the workflows service)
//   • GET /workflows/catalog (JSON Schema rendering for the Batch 17 UI)
//   • the future Batch 16 engine (same config types, same refs)
//
// Every entry maps to a capability the product ALREADY has (existing CRM
// services/routes). Nothing here executes anything — Batch 15 stores and
// validates definitions only. Definitions are pure data: typed primitives and
// ids/keys of tenant records. There is no field for code, SQL, JavaScript or
// expressions, and all config objects are strict (unknown keys are rejected).
//
// AI boundary: no trigger/action calls an AI provider. The lead assignment
// strategy "ai" that the manual assign endpoint offers is deliberately NOT part
// of this catalog.

export const WORKFLOW_SCHEMA_VERSION = 1;

export const WORKFLOW_LIMITS = {
  nameMaxLength: 120,
  descriptionMaxLength: 2000,
  maxConditions: 25,
  maxActions: 20,
  maxListValues: 50,
  maxValueLength: 500,
  maxDefinitionBytes: 32 * 1024,
} as const;

// Definition-management lifecycle. NO state executes anything in Batch 15.
export const WORKFLOW_STATUSES = ["draft", "published", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_LIFECYCLE: Record<WorkflowStatus, { label: string; description: string; editable: boolean; deletable: boolean; transitions: readonly WorkflowStatus[] }> = {
  draft: {
    label: "Draft",
    description: "Editable working copy. Never eligible for execution. Can be published (requires a fully valid definition with at least one action), archived, or hard-deleted (DELETE requires the current revision in its body, like every other mutation).",
    editable: true,
    deletable: true,
    transitions: ["published", "archived"],
  },
  published: {
    label: "Published",
    description: "The definition a future execution engine (Batch 16) may consider eligible. Batch 15 itself never executes it. IMMUTABLE: it cannot be edited or hard-deleted — to change it, unpublish it (back to draft), edit, then publish again, so every change to an eligible definition crosses an explicit publish boundary. Can be unpublished or archived.",
    editable: false,
    deletable: false,
    transitions: ["draft", "archived"],
  },
  archived: {
    label: "Archived",
    description: "Terminal, read-only history. Cannot be edited, published, unpublished or deleted.",
    editable: false,
    deletable: false,
    transitions: [],
  },
};

export const WORKFLOW_ENTITIES = ["lead", "contact"] as const;
export type WorkflowEntity = (typeof WORKFLOW_ENTITIES)[number];

// Value lists mirrored from the existing CRM contracts (kept in sync by unit test
// against the generated OpenAPI Zod schemas).
export const CONTACT_STATUSES = ["new", "contacted", "quotation_sent", "negotiation", "won", "lost", "qualified", "interested", "proposal_sent", "archived"] as const;
export const LEAD_TEMPERATURES = ["hot", "warm", "cold"] as const;
export const TASK_TYPES = ["call", "follow_up", "meeting", "proposal", "custom"] as const;
// "ai" (offered by POST /leads/{id}/assign) is intentionally excluded — AI boundary.
export const LEAD_ASSIGNMENT_STRATEGIES = ["manual", "round_robin", "load_balanced", "availability", "territory"] as const;

// ── Tenant references ───────────────────────────────────────────────────────
// Ids/keys inside a config that MUST belong to the definition's own company.
// Validated by the service with refInCompany (rows) / the pipeline stage lookup.
export type RefTable = "users" | "tags" | "teams" | "events" | "organizations";
export type TenantRef = { path: string; kind: "row"; table: RefTable } | { path: string; kind: "stageKey" };

// ── Condition fields ────────────────────────────────────────────────────────
export type ConditionFieldType = "string" | "number" | "boolean" | "enum" | "id" | "list";

export interface ConditionFieldDef {
  key: string;
  label: string;
  type: ConditionFieldType;
  enumValues?: readonly string[];
}

const leadFields: readonly ConditionFieldDef[] = [
  { key: "stage", label: "Pipeline stage key", type: "string" },
  { key: "source", label: "Source", type: "string" },
  { key: "title", label: "Title", type: "string" },
  { key: "companyName", label: "Company name", type: "string" },
  { key: "priority", label: "Priority", type: "string" },
  { key: "currency", label: "Currency", type: "string" },
  { key: "value", label: "Value", type: "number" },
  { key: "probability", label: "Probability (%)", type: "number" },
  { key: "assignedToId", label: "Owner (user id)", type: "id" },
  { key: "teamId", label: "Team id", type: "id" },
  { key: "eventId", label: "Event id", type: "id" },
  { key: "organizationId", label: "Organization id", type: "id" },
  { key: "contactId", label: "Contact id", type: "id" },
  { key: "createdById", label: "Created by (user id)", type: "id" },
];

const contactFields: readonly ConditionFieldDef[] = [
  { key: "status", label: "Lead status", type: "enum", enumValues: CONTACT_STATUSES },
  { key: "leadTemperature", label: "Lead temperature", type: "enum", enumValues: LEAD_TEMPERATURES },
  { key: "leadScore", label: "Lead score", type: "number" },
  { key: "source", label: "Source", type: "string" },
  { key: "firstName", label: "First name", type: "string" },
  { key: "lastName", label: "Last name", type: "string" },
  { key: "fullName", label: "Full name", type: "string" },
  { key: "jobTitle", label: "Job title", type: "string" },
  { key: "contactCompany", label: "Company (free text)", type: "string" },
  { key: "email", label: "Email", type: "string" },
  { key: "mobile", label: "Mobile", type: "string" },
  { key: "country", label: "Country", type: "string" },
  { key: "city", label: "City", type: "string" },
  { key: "industry", label: "Industry", type: "string" },
  { key: "seniority", label: "Seniority", type: "string" },
  { key: "tags", label: "Tags", type: "list" },
  { key: "assignedToId", label: "Owner (user id)", type: "id" },
  { key: "eventId", label: "Event id", type: "id" },
  { key: "organizationId", label: "Organization id", type: "id" },
  { key: "createdById", label: "Created by (user id)", type: "id" },
];

export const CONDITION_FIELDS: Record<WorkflowEntity, readonly ConditionFieldDef[]> = {
  lead: leadFields,
  contact: contactFields,
};

export function conditionField(entity: WorkflowEntity, key: string): ConditionFieldDef | undefined {
  return CONDITION_FIELDS[entity].find((f) => f.key === key);
}

// ── Condition operators ─────────────────────────────────────────────────────
export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type OperatorValueShape = "single" | "list" | "none";

export const OPERATOR_DEFS: Record<ConditionOperator, { label: string; valueShape: OperatorValueShape }> = {
  equals: { label: "equals", valueShape: "single" },
  not_equals: { label: "does not equal", valueShape: "single" },
  contains: { label: "contains", valueShape: "single" },
  not_contains: { label: "does not contain", valueShape: "single" },
  in: { label: "is one of", valueShape: "list" },
  not_in: { label: "is not one of", valueShape: "list" },
  is_empty: { label: "is empty", valueShape: "none" },
  is_not_empty: { label: "is not empty", valueShape: "none" },
  greater_than: { label: "is greater than", valueShape: "single" },
  less_than: { label: "is less than", valueShape: "single" },
};

export const OPERATORS_BY_FIELD_TYPE: Record<ConditionFieldType, readonly ConditionOperator[]> = {
  string: ["equals", "not_equals", "contains", "not_contains", "in", "not_in", "is_empty", "is_not_empty"],
  enum: ["equals", "not_equals", "in", "not_in", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "in", "not_in", "is_empty", "is_not_empty", "greater_than", "less_than"],
  id: ["equals", "not_equals", "in", "not_in", "is_empty", "is_not_empty"],
  boolean: ["equals", "not_equals", "is_empty", "is_not_empty"],
  list: ["contains", "not_contains", "is_empty", "is_not_empty"],
};

// ── Shared config building blocks ───────────────────────────────────────────
const positiveId = z.number().int().positive();
const shortText = (max: number) => z.string().trim().min(1).max(max);
const longText = (max: number) => z.string().max(max);
// Stage keys are tenant-configurable slugs (legacy defaults: prospect, qualified,
// proposal_sent, negotiation, won, lost). Existence is verified per tenant.
const stageKey = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, "stage key must be a lowercase slug");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const dayOffset = z.number().int().min(0).max(365);

// Who receives a task / follow-up / notification / email produced by an action.
// Resolved by the (future) engine from the triggering record; never free-form.
export const RECIPIENT_KINDS = ["record_owner", "actor", "user", "contact"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];
export const RECIPIENT_KIND_LABELS: Record<RecipientKind, string> = {
  record_owner: "The record's owner (assigned user)",
  actor: "The user whose action fired the trigger",
  user: "A specific user of this company (userId)",
  contact: "The contact's own email address (email actions only)",
};

function recipientSchema(kinds: readonly RecipientKind[]) {
  return z
    .strictObject({
      kind: z.enum(kinds as [RecipientKind, ...RecipientKind[]]),
      userId: positiveId.optional(),
    })
    .refine((r) => (r.kind === "user" ? r.userId != null : r.userId == null), {
      message: 'userId is required when kind is "user" and not allowed otherwise',
      path: ["userId"],
    });
}

function atLeastOneKey<T extends Record<string, unknown>>(obj: T): boolean {
  return Object.values(obj).some((v) => v !== undefined);
}

const leadFieldKeys = leadFields.map((f) => f.key) as [string, ...string[]];
const contactFieldKeys = contactFields.map((f) => f.key) as [string, ...string[]];

// ── Triggers ────────────────────────────────────────────────────────────────
export interface TriggerDef {
  entity: WorkflowEntity;
  label: string;
  description: string;
  configSchema: z.ZodType;
  refs: readonly TenantRef[];
}

export const WORKFLOW_TRIGGERS = {
  "lead.created": {
    entity: "lead",
    label: "Lead created",
    description: "A lead is created (manual, capture or import).",
    configSchema: z.strictObject({}),
    refs: [],
  },
  "lead.updated": {
    entity: "lead",
    label: "Lead updated",
    description: "A lead is edited. Optionally restrict to specific fields.",
    configSchema: z.strictObject({ fields: z.array(z.enum(leadFieldKeys)).min(1).max(20).optional() }),
    refs: [],
  },
  "lead.stage_changed": {
    entity: "lead",
    label: "Lead stage changed",
    description: "A lead moves to another pipeline stage. Optionally restrict by from/to stage key.",
    configSchema: z.strictObject({ fromStageKey: stageKey.optional(), toStageKey: stageKey.optional() }),
    refs: [
      { path: "fromStageKey", kind: "stageKey" },
      { path: "toStageKey", kind: "stageKey" },
    ],
  },
  "lead.assigned": {
    entity: "lead",
    label: "Lead owner assigned",
    description: "A lead's owner (assigned user) is set or changed.",
    configSchema: z.strictObject({}),
    refs: [],
  },
  "contact.created": {
    entity: "contact",
    label: "Contact created",
    description: "A contact is created (scan, manual, import).",
    configSchema: z.strictObject({}),
    refs: [],
  },
  "contact.updated": {
    entity: "contact",
    label: "Contact updated",
    description: "A contact is edited. Optionally restrict to specific fields.",
    configSchema: z.strictObject({ fields: z.array(z.enum(contactFieldKeys)).min(1).max(20).optional() }),
    refs: [],
  },
  "contact.status_changed": {
    entity: "contact",
    label: "Contact lead-status changed",
    description: "A contact's lead status changes (this product tracks lead status on the contact). Optionally restrict by from/to status.",
    configSchema: z.strictObject({ fromStatus: z.enum(CONTACT_STATUSES).optional(), toStatus: z.enum(CONTACT_STATUSES).optional() }),
    refs: [],
  },
} as const satisfies Record<string, TriggerDef>;

export type WorkflowTriggerType = keyof typeof WORKFLOW_TRIGGERS;
export const TRIGGER_TYPES = Object.keys(WORKFLOW_TRIGGERS) as [WorkflowTriggerType, ...WorkflowTriggerType[]];

// ── Actions ─────────────────────────────────────────────────────────────────
export interface ActionDef {
  label: string;
  description: string;
  entities: readonly WorkflowEntity[];
  configSchema: z.ZodType;
  refs: readonly TenantRef[];
}

export const WORKFLOW_ACTIONS = {
  "lead.assign_owner": {
    label: "Assign lead owner",
    description: "Assign the lead to a specific user (manual) or via an existing deterministic assignment rule (round robin, load balanced, availability, territory). Maps to POST /leads/{id}/assign.",
    entities: ["lead"],
    configSchema: z
      .strictObject({
        strategy: z.enum(LEAD_ASSIGNMENT_STRATEGIES).default("manual"),
        assignedToId: positiveId.optional(),
        teamId: positiveId.optional(),
      })
      .refine((c) => (c.strategy === "manual" ? c.assignedToId != null : c.assignedToId == null), {
        message: 'assignedToId is required for the "manual" strategy and not allowed for rule-based strategies',
        path: ["assignedToId"],
      }),
    refs: [
      { path: "assignedToId", kind: "row", table: "users" },
      { path: "teamId", kind: "row", table: "teams" },
    ],
  },
  "lead.update_fields": {
    label: "Update lead fields",
    description: "Set lead fields, including the pipeline stage (by key). Maps to PATCH /leads/{id}.",
    entities: ["lead"],
    configSchema: z.strictObject({
      fields: z
        .strictObject({
          stage: stageKey.optional(),
          source: shortText(120).optional(),
          title: shortText(200).optional(),
          value: z.number().min(0).max(1_000_000_000_000).optional(),
          currency: z.string().regex(/^[A-Z]{3}$/, "expected a 3-letter currency code").optional(),
          closingDate: dateOnly.optional(),
          probability: z.number().int().min(0).max(100).optional(),
          priority: shortText(50).optional(),
          notes: longText(5000).optional(),
          companyName: shortText(200).optional(),
          teamId: positiveId.optional(),
          eventId: positiveId.optional(),
          organizationId: positiveId.optional(),
        })
        .refine(atLeastOneKey, { message: "at least one field is required" }),
    }),
    refs: [
      { path: "fields.stage", kind: "stageKey" },
      { path: "fields.teamId", kind: "row", table: "teams" },
      { path: "fields.eventId", kind: "row", table: "events" },
      { path: "fields.organizationId", kind: "row", table: "organizations" },
    ],
  },
  "lead.add_tag": {
    label: "Add tag to lead",
    description: "Attach an existing tag. Maps to POST /leads/{id}/tags.",
    entities: ["lead"],
    configSchema: z.strictObject({ tagId: positiveId }),
    refs: [{ path: "tagId", kind: "row", table: "tags" }],
  },
  "lead.remove_tag": {
    label: "Remove tag from lead",
    description: "Detach a tag. Maps to DELETE /leads/{id}/tags/{tagId}.",
    entities: ["lead"],
    configSchema: z.strictObject({ tagId: positiveId }),
    refs: [{ path: "tagId", kind: "row", table: "tags" }],
  },
  "contact.update_fields": {
    label: "Update contact fields",
    description: "Set contact fields, including the lead status. Maps to PATCH /contacts/{id}.",
    entities: ["contact"],
    configSchema: z.strictObject({
      fields: z
        .strictObject({
          status: z.enum(CONTACT_STATUSES).optional(),
          statusComment: longText(500).optional(),
          source: shortText(120).optional(),
          jobTitle: shortText(200).optional(),
          contactCompany: shortText(200).optional(),
          country: shortText(100).optional(),
          city: shortText(100).optional(),
          notes: longText(5000).optional(),
          leadTemperature: z.enum(LEAD_TEMPERATURES).optional(),
          eventId: positiveId.optional(),
          organizationId: positiveId.optional(),
        })
        .refine(atLeastOneKey, { message: "at least one field is required" }),
    }),
    refs: [
      { path: "fields.eventId", kind: "row", table: "events" },
      { path: "fields.organizationId", kind: "row", table: "organizations" },
    ],
  },
  "contact.assign_owner": {
    label: "Assign contact owner",
    description: "Set the contact's assigned user. Maps to PATCH /contacts/{id} (assignedToId).",
    entities: ["contact"],
    configSchema: z.strictObject({ assignedToId: positiveId }),
    refs: [{ path: "assignedToId", kind: "row", table: "users" }],
  },
  "contact.add_tag": {
    label: "Add tag to contact",
    description: "Add a tag label to the contact's tag list. Maps to PATCH /contacts/{id} (tags).",
    entities: ["contact"],
    configSchema: z.strictObject({ tag: shortText(50) }),
    refs: [],
  },
  "contact.remove_tag": {
    label: "Remove tag from contact",
    description: "Remove a tag label from the contact's tag list. Maps to PATCH /contacts/{id} (tags).",
    entities: ["contact"],
    configSchema: z.strictObject({ tag: shortText(50) }),
    refs: [],
  },
  "task.create": {
    label: "Create task",
    description: "Create a task linked to the record's contact. Maps to POST /tasks.",
    entities: ["lead", "contact"],
    configSchema: z.strictObject({
      title: shortText(200),
      type: z.enum(TASK_TYPES).default("custom"),
      notes: longText(2000).optional(),
      dueInDays: dayOffset.optional(),
      dueTime: timeOfDay.optional(),
      assignee: recipientSchema(["record_owner", "actor", "user"]),
    }),
    refs: [{ path: "assignee.userId", kind: "row", table: "users" }],
  },
  "follow_up.create": {
    label: "Schedule follow-up",
    description: "Schedule a follow-up for the record's contact (a lead without a contact is skipped by the engine). Maps to POST /follow-ups.",
    entities: ["lead", "contact"],
    configSchema: z.strictObject({
      scheduleInDays: dayOffset,
      scheduledTime: timeOfDay.optional(),
      notes: longText(2000).optional(),
      assignee: recipientSchema(["record_owner", "actor", "user"]).optional(),
    }),
    refs: [{ path: "assignee.userId", kind: "row", table: "users" }],
  },
  "notification.create": {
    label: "Create in-app notification",
    description: "Create an in-app notification for a user of this company (existing notification service).",
    entities: ["lead", "contact"],
    configSchema: z.strictObject({
      title: shortText(200),
      body: longText(1000).optional(),
      recipient: recipientSchema(["record_owner", "actor", "user"]),
    }),
    refs: [{ path: "recipient.userId", kind: "row", table: "users" }],
  },
  "email.send": {
    label: "Send email",
    description: "Send a plain-text email through the platform's configured email provider (existing queued email delivery). Definitions never contain provider credentials.",
    entities: ["lead", "contact"],
    configSchema: z.strictObject({
      to: recipientSchema(["record_owner", "actor", "user", "contact"]),
      subject: shortText(200),
      body: z.string().trim().min(1).max(5000),
    }),
    refs: [{ path: "to.userId", kind: "row", table: "users" }],
  },
} as const satisfies Record<string, ActionDef>;

export type WorkflowActionType = keyof typeof WORKFLOW_ACTIONS;
export const ACTION_TYPES = Object.keys(WORKFLOW_ACTIONS) as [WorkflowActionType, ...WorkflowActionType[]];

// ── Catalog description (GET /workflows/catalog) ────────────────────────────
// JSON Schema is rendered from the same Zod schemas the validator uses, so the
// UI and the API can never disagree about a config shape.
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

let catalogCache: ReturnType<typeof buildCatalog> | null = null;

// The catalog is static for the life of the process; render it once.
export function describeCatalog() {
  if (!catalogCache) catalogCache = buildCatalog();
  return catalogCache;
}

function buildCatalog() {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    limits: { ...WORKFLOW_LIMITS },
    statuses: [...WORKFLOW_STATUSES],
    lifecycle: WORKFLOW_LIFECYCLE,
    entities: [...WORKFLOW_ENTITIES],
    triggers: TRIGGER_TYPES.map((type) => {
      const def: TriggerDef = WORKFLOW_TRIGGERS[type];
      return { type, entity: def.entity, label: def.label, description: def.description, configSchema: jsonSchema(def.configSchema) };
    }),
    conditionOperators: CONDITION_OPERATORS.map((operator) => ({ operator, ...OPERATOR_DEFS[operator] })),
    conditionFields: Object.fromEntries(
      WORKFLOW_ENTITIES.map((entity) => [
        entity,
        CONDITION_FIELDS[entity].map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          enumValues: f.enumValues ? [...f.enumValues] : undefined,
          operators: [...OPERATORS_BY_FIELD_TYPE[f.type]],
        })),
      ]),
    ) as Record<WorkflowEntity, Array<{ key: string; label: string; type: ConditionFieldType; enumValues?: string[]; operators: ConditionOperator[] }>>,
    actions: ACTION_TYPES.map((type) => {
      const def: ActionDef = WORKFLOW_ACTIONS[type];
      return { type, label: def.label, description: def.description, entities: [...def.entities], configSchema: jsonSchema(def.configSchema) };
    }),
    recipientKinds: RECIPIENT_KINDS.map((kind) => ({ kind, label: RECIPIENT_KIND_LABELS[kind] })),
  };
}
