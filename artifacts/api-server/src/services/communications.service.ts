import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as repo from "../repositories/lead_activities.repository.js";
import * as leadsRepo from "../repositories/leads.repository.js";
import * as contactsRepo from "../repositories/contacts.repository.js";
import { formatActivity } from "./lead_activities.service.js";

type Channel = "email" | "phone" | "whatsapp" | "calendar";

/** Communication channel → lead_activities.type. */
const CHANNEL_TO_TYPE: Record<Channel, string> = {
  email: "email",
  phone: "call",
  whatsapp: "message",
  calendar: "meeting",
};

function resolveChannel(channel?: string): Channel {
  if (channel === "email" || channel === "phone" || channel === "whatsapp" || channel === "calendar") {
    return channel;
  }
  throw new AppError(400, "Invalid communication channel");
}

/** Only activities logged through the Communication Hub carry a metadata.channel. */
function isCommunication(a: repo.LeadActivityWithUser): boolean {
  const md = a.metadata as { channel?: unknown } | null;
  return !!md && typeof md === "object" && typeof (md as { channel?: unknown }).channel === "string";
}

interface CommInput {
  channel?: string;
  subject?: string | null;
  body?: string | null;
  occurredAt?: string | null;
}

function resolveOccurredAt(occurredAt?: string | null): Date {
  const d = occurredAt ? new Date(occurredAt) : new Date();
  if (isNaN(d.getTime())) throw new AppError(400, "Invalid occurredAt");
  return d;
}

// ── Contacts ──────────────────────────────────────────────────────────────

export async function listContactCommunications(user: AuthUser, contactId: number) {
  const contact = await contactsRepo.findById(user, contactId);
  if (!contact) throw new AppError(404, "Contact not found");
  const rows = await repo.listForContact(user, contactId);
  return { communications: rows.filter(isCommunication).map(formatActivity) };
}

export async function logContactCommunication(user: AuthUser, contactId: number, input: CommInput) {
  const contact = await contactsRepo.findById(user, contactId);
  if (!contact) throw new AppError(404, "Contact not found");
  const channel = resolveChannel(input.channel);
  const occurredAt = resolveOccurredAt(input.occurredAt);
  const row = await repo.insert({
    companyId: contact.companyId,
    leadId: null,
    contactId,
    userId: user.id,
    type: CHANNEL_TO_TYPE[channel],
    source: "manual",
    subject: input.subject ?? null,
    body: input.body ?? null,
    metadata: { channel },
    occurredAt,
  });
  const full = await repo.getByIdWithUser(row.id);
  return formatActivity(full!);
}

// ── Leads ─────────────────────────────────────────────────────────────────

export async function listLeadCommunications(user: AuthUser, leadId: number) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  const rows = await repo.listForLead(user, leadId);
  return { communications: rows.filter(isCommunication).map(formatActivity) };
}

export async function logLeadCommunication(user: AuthUser, leadId: number, input: CommInput) {
  const lead = await leadsRepo.findById(user, leadId);
  if (!lead) throw new AppError(404, "Lead not found");
  const channel = resolveChannel(input.channel);
  const occurredAt = resolveOccurredAt(input.occurredAt);
  const row = await repo.insert({
    companyId: lead.companyId,
    leadId,
    contactId: lead.contactId ?? null,
    userId: user.id,
    type: CHANNEL_TO_TYPE[channel],
    source: "manual",
    subject: input.subject ?? null,
    body: input.body ?? null,
    metadata: { channel },
    occurredAt,
  });
  const full = await repo.getByIdWithUser(row.id);
  return formatActivity(full!);
}

// ── Calendar invite (.ics) ──────────────────────────────────────────────────

function icsEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

interface CalendarInput {
  title?: string;
  description?: string | null;
  location?: string | null;
  startAt?: string;
  durationMinutes?: number;
}

export async function createContactCalendarInvite(user: AuthUser, contactId: number, input: CalendarInput) {
  const contact = await contactsRepo.findById(user, contactId);
  if (!contact) throw new AppError(404, "Contact not found");
  const title = (input.title ?? "").trim();
  if (!title) throw new AppError(400, "title required");
  if (!input.startAt) throw new AppError(400, "startAt required");
  const start = new Date(input.startAt);
  if (isNaN(start.getTime())) throw new AppError(400, "Invalid startAt");
  const duration = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes : 30;
  const end = new Date(start.getTime() + duration * 60000);

  const uid = `csp-${contactId}-${Date.now()}@cardscannerpro`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Card Scanner Pro//Communication Hub//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
  ];
  if (input.description) lines.push(`DESCRIPTION:${icsEscape(input.description)}`);
  if (input.location) lines.push(`LOCATION:${icsEscape(input.location)}`);
  if (contact.email) {
    const cn = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email;
    lines.push(`ATTENDEE;CN=${icsEscape(cn)}:mailto:${contact.email}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  const ics = lines.join("\r\n");

  const row = await repo.insert({
    companyId: contact.companyId,
    leadId: null,
    contactId,
    userId: user.id,
    type: "meeting",
    source: "manual",
    subject: title,
    body: input.description ?? null,
    metadata: {
      channel: "calendar",
      startAt: start.toISOString(),
      durationMinutes: duration,
      location: input.location ?? null,
    },
    occurredAt: start,
  });
  const full = await repo.getByIdWithUser(row.id);
  return { ics, filename: `invite-${contactId}.ics`, communication: formatActivity(full!) };
}
