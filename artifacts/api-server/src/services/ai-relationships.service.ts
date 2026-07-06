import { db, contactsTable, leadsTable, organizationsTable, eventsTable } from "@workspace/db";
import type { Contact, Lead, Organization } from "@workspace/db";
import { and, eq, ne, isNull, inArray } from "drizzle-orm";

// Deterministic "relationship intelligence" engine for Stage 5A. It surfaces the
// connections that ALREADY exist between records in the tenant's CRM. It is pure fact
// derivation over stored rows — NO LLM, NO fabricated data. Every builder returns a
// reviewable insight payload (source "deterministic", confidence 100, human reasoning).
//
// Patterns surfaced (per the Stage 5A spec):
//  - same-company contacts (colleagues)
//  - multiple decision makers at a company
//  - repeat interactions across events
//  - previously-visited companies (an account seen at more than one event)
//  - existing / inactive customers (derived from status / won-lost stage)
//  - high-value companies touching multiple employees (an account engaged by >1 rep)
//  - connected leads (leads sharing a contact / organization)
// When a record has no links it says so honestly rather than inventing relationships.

export interface DeterministicInsight {
  data: Record<string, unknown>;
  confidence: number;
  reasoning: string;
}

function normName(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function contactLabel(c: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): string {
  const parts = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return parts || c.fullName || "Unnamed contact";
}

// Job titles that indicate buying authority. Used to flag "multiple decision makers".
const DECISION_MAKER_RE =
  /\b(ceo|cfo|coo|cto|cmo|cio|cxo|chief|founder|co-?founder|owner|proprietor|president|vice[- ]?president|vp|svp|evp|director|head\b|partner|principal|managing|general manager|gm|board|executive)\b/i;
function isDecisionMaker(title?: string | null): boolean {
  return !!title && DECISION_MAKER_RE.test(title);
}

// Customer lifecycle derivation — grounded ONLY in stored status/stage, never guessed.
function contactCustomerStatus(status: string | null | undefined): "existing_customer" | "inactive" | null {
  const s = (status ?? "").toLowerCase();
  if (s === "won") return "existing_customer";
  if (s === "lost" || s === "archived") return "inactive";
  return null;
}
function stageCustomerStatus(stage: string | null | undefined): "existing_customer" | "inactive" | null {
  const s = (stage ?? "").toLowerCase();
  if (s.includes("won")) return "existing_customer";
  if (s.includes("lost")) return "inactive";
  return null;
}

async function eventNamesByIds(cid: number, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: eventsTable.name })
    .from(eventsTable)
    .where(and(eq(eventsTable.companyId, cid), inArray(eventsTable.id, ids)));
  return rows.map((r) => r.name).filter((n): n is string => Boolean(n));
}

// ── Contact ────────────────────────────────────────────────────────────────
export async function contactRelationships(cid: number, c: Contact): Promise<DeterministicInsight> {
  const relLeads = await db
    .select({
      id: leadsTable.id,
      title: leadsTable.title,
      stage: leadsTable.stage,
      value: leadsTable.value,
      currency: leadsTable.currency,
      eventId: leadsTable.eventId,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, cid), eq(leadsTable.contactId, c.id), isNull(leadsTable.deletedAt)))
    .limit(50);

  let organization: string | null = null;
  if (c.organizationId != null) {
    const [o] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(and(eq(organizationsTable.companyId, cid), eq(organizationsTable.id, c.organizationId), isNull(organizationsTable.deletedAt)))
      .limit(1);
    organization = o?.name ?? null;
  }
  if (!organization) organization = c.contactCompany ?? null;

  const candidates = await db
    .select({
      id: contactsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      fullName: contactsTable.fullName,
      jobTitle: contactsTable.jobTitle,
      organizationId: contactsTable.organizationId,
      contactCompany: contactsTable.contactCompany,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, cid), ne(contactsTable.id, c.id), isNull(contactsTable.deletedAt)))
    .limit(500);

  const targetCompany = normName(c.contactCompany);
  const colleagueRows = candidates.filter(
    (r) =>
      (c.organizationId != null && r.organizationId === c.organizationId) ||
      (targetCompany !== "" && normName(r.contactCompany) === targetCompany),
  );
  const colleagues = colleagueRows
    .slice(0, 15)
    .map((r) => ({ id: r.id, name: contactLabel(r), jobTitle: r.jobTitle ?? null }));

  // Multiple decision makers at the same company (self + colleagues with authority titles).
  const decisionMakers = [
    ...(isDecisionMaker(c.jobTitle) ? [{ id: c.id, name: contactLabel(c), jobTitle: c.jobTitle ?? null, self: true }] : []),
    ...colleagueRows
      .filter((r) => isDecisionMaker(r.jobTitle))
      .slice(0, 15)
      .map((r) => ({ id: r.id, name: contactLabel(r), jobTitle: r.jobTitle ?? null, self: false })),
  ];
  const multipleDecisionMakers = decisionMakers.length >= 2;

  // Repeat interactions across events: distinct events across this contact's leads + its own capture event.
  const eventIdSet = new Set<number>(relLeads.map((l) => l.eventId).filter((x): x is number => x != null));
  if (c.eventId != null) eventIdSet.add(c.eventId);
  const eventIds = [...eventIdSet];
  const events = await eventNamesByIds(cid, eventIds);
  const repeatInteractions = eventIds.length >= 2;

  const customerStatus = contactCustomerStatus(c.status);

  const suggestedActions: string[] = [];
  if (multipleDecisionMakers && organization) {
    suggestedActions.push(`${decisionMakers.length} decision makers identified at ${organization} — build a buying-committee plan.`);
  } else if (colleagues.length > 0 && organization) {
    suggestedActions.push(`${colleagues.length} colleague(s) already in your CRM at ${organization} — consider a multi-threaded approach.`);
  }
  if (repeatInteractions) {
    suggestedActions.push(`Engaged across ${eventIds.length} events — a warm, recurring relationship worth prioritising.`);
  }
  if (customerStatus === "existing_customer") {
    suggestedActions.push("Existing customer — look for expansion / cross-sell opportunities.");
  } else if (customerStatus === "inactive") {
    suggestedActions.push("Marked lost/archived — consider a re-engagement campaign.");
  }
  if (relLeads.length > 0) {
    suggestedActions.push(`${relLeads.length} linked opportunity/opportunities — review pipeline status together.`);
  }

  const total = colleagues.length + relLeads.length + events.length;
  const reasoning =
    total === 0
      ? "No related records found in your CRM for this contact yet."
      : `Connected in your CRM to ${colleagues.length} colleague(s)` +
        (organization ? ` at ${organization}` : "") +
        `, ${relLeads.length} linked lead(s), and ${events.length} event(s)` +
        (multipleDecisionMakers ? `; ${decisionMakers.length} decision makers` : "") +
        (customerStatus ? `; status: ${customerStatus.replace("_", " ")}` : "") +
        ".";

  return {
    data: {
      organization,
      colleagues,
      decisionMakers,
      multipleDecisionMakers,
      relatedLeads: relLeads.map((l) => ({ id: l.id, title: l.title, stage: l.stage, value: l.value })),
      events,
      repeatInteractions,
      customerStatus,
      counts: {
        colleagues: colleagues.length,
        relatedLeads: relLeads.length,
        events: events.length,
        decisionMakers: decisionMakers.length,
      },
      suggestedActions,
    },
    confidence: 100,
    reasoning,
  };
}

// ── Lead ───────────────────────────────────────────────────────────────────
export async function leadRelationships(cid: number, l: Lead): Promise<DeterministicInsight> {
  let contact: { id: number; name: string; decisionMaker: boolean } | null = null;
  if (l.contactId != null) {
    const [c] = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        fullName: contactsTable.fullName,
        jobTitle: contactsTable.jobTitle,
      })
      .from(contactsTable)
      .where(and(eq(contactsTable.companyId, cid), eq(contactsTable.id, l.contactId), isNull(contactsTable.deletedAt)))
      .limit(1);
    if (c) contact = { id: c.id, name: contactLabel(c), decisionMaker: isDecisionMaker(c.jobTitle) };
  }

  let organization: string | null = null;
  if (l.organizationId != null) {
    const [o] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(and(eq(organizationsTable.companyId, cid), eq(organizationsTable.id, l.organizationId), isNull(organizationsTable.deletedAt)))
      .limit(1);
    organization = o?.name ?? null;
  }
  if (!organization) organization = l.companyName ?? null;

  const candidates = await db
    .select({
      id: leadsTable.id,
      title: leadsTable.title,
      stage: leadsTable.stage,
      value: leadsTable.value,
      contactId: leadsTable.contactId,
      organizationId: leadsTable.organizationId,
      eventId: leadsTable.eventId,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, cid), ne(leadsTable.id, l.id), isNull(leadsTable.deletedAt)))
    .limit(500);

  const siblingRows = candidates.filter(
    (r) =>
      (l.contactId != null && r.contactId === l.contactId) ||
      (l.organizationId != null && r.organizationId === l.organizationId),
  );
  const siblingLeads = siblingRows
    .slice(0, 15)
    .map((r) => ({ id: r.id, title: r.title, stage: r.stage, value: r.value }));

  // Repeat interactions across events: this lead's event + sibling leads' events.
  const eventIdSet = new Set<number>(siblingRows.map((r) => r.eventId).filter((x): x is number => x != null));
  if (l.eventId != null) eventIdSet.add(l.eventId);
  const eventIds = [...eventIdSet];
  const eventNames = await eventNamesByIds(cid, eventIds);
  const repeatInteractions = eventIds.length >= 2;
  const event = l.eventId != null ? (await eventNamesByIds(cid, [l.eventId]))[0] ?? null : null;

  const customerStatus = stageCustomerStatus(l.stage);

  const suggestedActions: string[] = [];
  if (siblingLeads.length > 0) {
    suggestedActions.push(`${siblingLeads.length} related lead(s) share this contact/organization — align your outreach.`);
  }
  if (contact?.decisionMaker) {
    suggestedActions.push("Primary contact appears to be a decision maker — prioritise executive engagement.");
  }
  if (repeatInteractions) {
    suggestedActions.push(`This account has been engaged across ${eventIds.length} events — a recurring relationship.`);
  }
  if (customerStatus === "existing_customer") {
    suggestedActions.push("This lead is won — track delivery and expansion.");
  } else if (customerStatus === "inactive") {
    suggestedActions.push("This lead is lost — capture the loss reason and consider nurture.");
  }
  if (!contact) {
    suggestedActions.push("This lead has no linked contact — attach one to enrich relationship context.");
  }

  const total = (contact ? 1 : 0) + siblingLeads.length + (event ? 1 : 0);
  const reasoning =
    total === 0
      ? "No related records found in your CRM for this lead yet."
      : `Connected in your CRM to ${contact ? "a primary contact" : "no contact"}` +
        (organization ? `, ${organization}` : "") +
        `, ${siblingLeads.length} related lead(s)` +
        (repeatInteractions ? `, across ${eventIds.length} events` : event ? `, captured at ${event}` : "") +
        (customerStatus ? `; status: ${customerStatus.replace("_", " ")}` : "") +
        ".";

  return {
    data: {
      contact,
      organization,
      siblingLeads,
      event,
      events: eventNames,
      repeatInteractions,
      customerStatus,
      counts: { siblingLeads: siblingLeads.length, events: eventIds.length },
      suggestedActions,
    },
    confidence: 100,
    reasoning,
  };
}

// ── Organization ─────────────────────────────────────────────────────────────
export async function organizationRelationships(cid: number, o: Organization): Promise<DeterministicInsight> {
  const contacts = await db
    .select({
      id: contactsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      fullName: contactsTable.fullName,
      jobTitle: contactsTable.jobTitle,
      assignedToId: contactsTable.assignedToId,
      eventId: contactsTable.eventId,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, cid), eq(contactsTable.organizationId, o.id), isNull(contactsTable.deletedAt)))
    .limit(100);

  const leads = await db
    .select({
      id: leadsTable.id,
      title: leadsTable.title,
      stage: leadsTable.stage,
      value: leadsTable.value,
      assignedToId: leadsTable.assignedToId,
      eventId: leadsTable.eventId,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, cid), eq(leadsTable.organizationId, o.id), isNull(leadsTable.deletedAt)))
    .limit(100);

  const keyContacts = contacts.slice(0, 15).map((c) => ({ id: c.id, name: contactLabel(c), jobTitle: c.jobTitle ?? null }));

  // Multiple decision makers within the account.
  const decisionMakers = contacts
    .filter((c) => isDecisionMaker(c.jobTitle))
    .slice(0, 15)
    .map((c) => ({ id: c.id, name: contactLabel(c), jobTitle: c.jobTitle ?? null }));
  const multipleDecisionMakers = decisionMakers.length >= 2;

  // High-value company touching multiple employees: distinct reps (assignedToId) across
  // the account's contacts + leads. Counts only — values are NOT summed (mixed currencies).
  const employeeSet = new Set<number>();
  for (const c of contacts) if (c.assignedToId != null) employeeSet.add(c.assignedToId);
  for (const l of leads) if (l.assignedToId != null) employeeSet.add(l.assignedToId);
  const employeeCount = employeeSet.size;
  const multiEmployeeEngagement = employeeCount >= 2;

  // Previously-visited company: distinct events the account has appeared at.
  const eventIdSet = new Set<number>();
  for (const c of contacts) if (c.eventId != null) eventIdSet.add(c.eventId);
  for (const l of leads) if (l.eventId != null) eventIdSet.add(l.eventId);
  const eventIds = [...eventIdSet];
  const events = await eventNamesByIds(cid, eventIds);
  const previouslyVisited = eventIds.length >= 2;

  // Customer status from won/lost leads + org archive flag.
  const hasWon = leads.some((l) => stageCustomerStatus(l.stage) === "existing_customer");
  const allLost = leads.length > 0 && leads.every((l) => stageCustomerStatus(l.stage) === "inactive");
  const customerStatus: "existing_customer" | "inactive" | null =
    hasWon ? "existing_customer" : (o.status ?? "").toLowerCase() === "archived" || allLost ? "inactive" : null;

  const suggestedActions: string[] = [];
  if (multipleDecisionMakers) {
    suggestedActions.push(`${decisionMakers.length} decision makers mapped — orchestrate a buying-committee strategy.`);
  } else if (contacts.length > 0) {
    suggestedActions.push(`${contacts.length} contact(s) mapped to this organization — map decision-makers.`);
  }
  if (multiEmployeeEngagement) {
    suggestedActions.push(`${employeeCount} of your team members are engaged with this account — coordinate to avoid channel conflict.`);
  }
  if (previouslyVisited) {
    suggestedActions.push(`Previously engaged across ${eventIds.length} events — a returning account worth prioritising.`);
  }
  if (customerStatus === "existing_customer") {
    suggestedActions.push("Existing customer — focus on retention and expansion.");
  } else if (customerStatus === "inactive") {
    suggestedActions.push("Inactive/archived account — evaluate re-engagement.");
  }
  if (leads.length > 0) {
    suggestedActions.push(`${leads.length} lead(s) tied to this account — review account health.`);
  }

  const total = contacts.length + leads.length;
  const reasoning =
    total === 0
      ? "No related records found in your CRM for this organization yet."
      : `This organization is linked to ${contacts.length} contact(s) and ${leads.length} lead(s) in your CRM` +
        (multipleDecisionMakers ? `; ${decisionMakers.length} decision makers` : "") +
        (multiEmployeeEngagement ? `; engaged by ${employeeCount} of your reps` : "") +
        (previouslyVisited ? `; seen across ${eventIds.length} events` : "") +
        (customerStatus ? `; status: ${customerStatus.replace("_", " ")}` : "") +
        ".";

  return {
    data: {
      keyContacts,
      decisionMakers,
      multipleDecisionMakers,
      relatedLeads: leads.map((l) => ({ id: l.id, title: l.title, stage: l.stage, value: l.value })),
      events,
      previouslyVisited,
      employeeCount,
      multiEmployeeEngagement,
      customerStatus,
      counts: {
        contacts: contacts.length,
        leads: leads.length,
        decisionMakers: decisionMakers.length,
        employees: employeeCount,
        events: eventIds.length,
      },
      suggestedActions,
    },
    confidence: 100,
    reasoning,
  };
}
