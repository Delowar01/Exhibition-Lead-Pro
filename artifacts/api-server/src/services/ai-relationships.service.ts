import { db, contactsTable, leadsTable, organizationsTable, eventsTable } from "@workspace/db";
import type { Contact, Lead, Organization } from "@workspace/db";
import { and, eq, ne, isNull, inArray } from "drizzle-orm";

// Deterministic "relationship intelligence" engine for Stage 5A. It surfaces the
// connections that ALREADY exist between records in the tenant's CRM (a contact's
// colleagues + linked leads + events, a lead's contact/org/sibling leads, an
// organization's contacts + leads). It is pure fact derivation over stored rows —
// NO LLM, NO fabricated data. Every builder returns a reviewable insight payload
// (source "deterministic", confidence 100, human reasoning). When a record has no
// links it says so honestly rather than inventing relationships.

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
  const colleagues = candidates
    .filter(
      (r) =>
        (c.organizationId != null && r.organizationId === c.organizationId) ||
        (targetCompany !== "" && normName(r.contactCompany) === targetCompany),
    )
    .slice(0, 15)
    .map((r) => ({ id: r.id, name: contactLabel(r), jobTitle: r.jobTitle ?? null }));

  const eventIds = [...new Set(relLeads.map((l) => l.eventId).filter((x): x is number => x != null))];
  const events = await eventNamesByIds(cid, eventIds);

  const suggestedActions: string[] = [];
  if (colleagues.length > 0 && organization) {
    suggestedActions.push(
      `${colleagues.length} colleague(s) already in your CRM at ${organization} — consider a multi-threaded approach.`,
    );
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
        `, ${relLeads.length} linked lead(s), and ${events.length} event(s).`;

  return {
    data: {
      organization,
      colleagues,
      relatedLeads: relLeads.map((l) => ({ id: l.id, title: l.title, stage: l.stage, value: l.value })),
      events,
      counts: { colleagues: colleagues.length, relatedLeads: relLeads.length, events: events.length },
      suggestedActions,
    },
    confidence: 100,
    reasoning,
  };
}

// ── Lead ───────────────────────────────────────────────────────────────────
export async function leadRelationships(cid: number, l: Lead): Promise<DeterministicInsight> {
  let contact: { id: number; name: string } | null = null;
  if (l.contactId != null) {
    const [c] = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        fullName: contactsTable.fullName,
      })
      .from(contactsTable)
      .where(and(eq(contactsTable.companyId, cid), eq(contactsTable.id, l.contactId), isNull(contactsTable.deletedAt)))
      .limit(1);
    if (c) contact = { id: c.id, name: contactLabel(c) };
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
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, cid), ne(leadsTable.id, l.id), isNull(leadsTable.deletedAt)))
    .limit(500);

  const siblingLeads = candidates
    .filter(
      (r) =>
        (l.contactId != null && r.contactId === l.contactId) ||
        (l.organizationId != null && r.organizationId === l.organizationId),
    )
    .slice(0, 15)
    .map((r) => ({ id: r.id, title: r.title, stage: r.stage, value: r.value }));

  let event: string | null = null;
  if (l.eventId != null) {
    const names = await eventNamesByIds(cid, [l.eventId]);
    event = names[0] ?? null;
  }

  const suggestedActions: string[] = [];
  if (siblingLeads.length > 0) {
    suggestedActions.push(`${siblingLeads.length} related lead(s) share this contact/organization — align your outreach.`);
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
        (event ? `, captured at ${event}.` : ".");

  return {
    data: { contact, organization, siblingLeads, event, counts: { siblingLeads: siblingLeads.length }, suggestedActions },
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
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.companyId, cid), eq(contactsTable.organizationId, o.id), isNull(contactsTable.deletedAt)))
    .limit(100);

  const leads = await db
    .select({ id: leadsTable.id, title: leadsTable.title, stage: leadsTable.stage, value: leadsTable.value })
    .from(leadsTable)
    .where(and(eq(leadsTable.companyId, cid), eq(leadsTable.organizationId, o.id), isNull(leadsTable.deletedAt)))
    .limit(100);

  const keyContacts = contacts.slice(0, 15).map((c) => ({ id: c.id, name: contactLabel(c), jobTitle: c.jobTitle ?? null }));

  const suggestedActions: string[] = [];
  if (contacts.length > 0) {
    suggestedActions.push(`${contacts.length} contact(s) mapped to this organization — map decision-makers.`);
  }
  if (leads.length > 0) {
    suggestedActions.push(`${leads.length} open/closed lead(s) tied to this account — review account health.`);
  }

  const total = contacts.length + leads.length;
  const reasoning =
    total === 0
      ? "No related records found in your CRM for this organization yet."
      : `This organization is linked to ${contacts.length} contact(s) and ${leads.length} lead(s) in your CRM.`;

  return {
    data: {
      keyContacts,
      relatedLeads: leads.map((l) => ({ id: l.id, title: l.title, stage: l.stage, value: l.value })),
      counts: { contacts: contacts.length, leads: leads.length },
      suggestedActions,
    },
    confidence: 100,
    reasoning,
  };
}
