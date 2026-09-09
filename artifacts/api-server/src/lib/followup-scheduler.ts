import { db } from "@workspace/db";
import { contactsTable } from "@workspace/db";
import { and, lte, isNotNull, isNull, ne, or, sql, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { notifyUser } from "./push.js";
import { writableCompanyIds } from "./company-access.js";

// Finds contacts whose follow-up is due today (or overdue) and pushes a
// reminder to the assigned rep. Each contact is notified at most once per
// follow-up date via the `followUpNotifiedOn` marker.
// Local YYYY-MM-DD (NOT UTC). `contacts.followUpDate` is a date-only local-day
// string, so we must compare against the local wall-clock date — toISOString()
// would shift the day across UTC boundaries.
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Finds contacts whose follow-up is due (or overdue) today and pushes a reminder to
// the assigned rep. Idempotent per follow-up date via the `followUpNotifiedOn` marker.
// Registered as a recurring task by the jobs scheduler (Phase 2.6).
export async function runFollowUpReminders(): Promise<void> {
  const todayStr = localDateStr(new Date());

  const due = await db
    .select({
      id: contactsTable.id,
      companyId: contactsTable.companyId,
      fullName: contactsTable.fullName,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      contactCompany: contactsTable.contactCompany,
      followUpDate: contactsTable.followUpDate,
      assignedToId: contactsTable.assignedToId,
    })
    .from(contactsTable)
    .where(
      and(
        // GAP-06 (Enterprise Privacy): explicit tenant boundary. This is a global sweep
        // across all companies, so we require a non-null tenant on every row. Combined with
        // the (companyId, assignedToId) grouping below, any future per-tenant logic added
        // here is structurally prevented from mixing records across tenants.
        isNotNull(contactsTable.companyId),
        isNotNull(contactsTable.followUpDate),
        lte(contactsTable.followUpDate, todayStr),
        isNotNull(contactsTable.assignedToId),
        sql`${contactsTable.status} NOT IN ('won', 'lost')`,
        or(
          isNull(contactsTable.followUpNotifiedOn),
          ne(contactsTable.followUpNotifiedOn, contactsTable.followUpDate),
        ),
      ),
    )
    .limit(500);

  if (due.length === 0) return;

  // B20 Correction 1: reminders (push + the followUpNotifiedOn CRM marker) are a
  // side effect — only tenants whose CANONICAL entitlement is `full` receive them.
  // Read-only / blocked tenants are skipped for this tick and picked up again
  // once their subscription is writable (the marker stays unset).
  const writable = await writableCompanyIds();
  const skippedTenants = new Set<number>();
  const eligible = due.filter((c) => {
    if (writable.has(c.companyId!)) return true;
    skippedTenants.add(c.companyId!);
    return false;
  });
  if (skippedTenants.size > 0) logger.info({ companies: skippedTenants.size, contacts: due.length - eligible.length }, "Follow-up reminders skipped: subscription not writable");
  if (eligible.length === 0) return;

  // One notification per rep, summarising their due follow-ups. Grouped strictly within
  // a (companyId, assignedToId) tenant boundary (GAP-06) — companyId is guaranteed non-null
  // by the query above, so every group belongs to exactly one tenant.
  const byCompanyUser = new Map<string, typeof due>();
  for (const c of eligible) {
    const key = `${c.companyId}:${c.assignedToId}`;
    const arr = byCompanyUser.get(key) ?? [];
    arr.push(c);
    byCompanyUser.set(key, arr);
  }

  const notifiedContactIds: number[] = [];
  let notifiedReps = 0;
  for (const [, contacts] of byCompanyUser) {
    const userId = contacts[0].assignedToId!;
    const first = contacts[0];
    const name =
      first.fullName ||
      [first.firstName, first.lastName].filter(Boolean).join(" ") ||
      "a contact";
    const suffix = first.contactCompany ? ` \u00b7 ${first.contactCompany}` : "";
    const payload =
      contacts.length === 1
        ? {
            title: "Follow-up due",
            body: `Time to follow up with ${name}${suffix}`,
            data: { type: "follow_up", contactId: first.id },
          }
        : {
            title: "Follow-ups due",
            body: `You have ${contacts.length} follow-ups due, starting with ${name}`,
            data: { type: "follow_up", contactId: first.id },
          };
    const sent = await notifyUser(userId, payload);
    // Only mark contacts as notified when a push actually went out; otherwise we
    // retry on the next tick (e.g. once the rep registers a device or Expo recovers).
    if (sent) {
      notifiedReps++;
      for (const c of contacts) notifiedContactIds.push(c.id);
    }
  }

  if (notifiedContactIds.length === 0) return;

  // Mark every successfully notified contact so we don't re-send for the same date.
  await db
    .update(contactsTable)
    .set({ followUpNotifiedOn: sql`${contactsTable.followUpDate}` })
    .where(inArray(contactsTable.id, notifiedContactIds));

  logger.info(
    { contacts: notifiedContactIds.length, reps: notifiedReps },
    "Sent due follow-up notifications",
  );
}
