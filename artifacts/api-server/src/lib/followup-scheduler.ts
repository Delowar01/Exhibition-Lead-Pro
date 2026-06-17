import { db } from "@workspace/db";
import { contactsTable } from "@workspace/db";
import { and, lte, isNotNull, isNull, ne, or, sql, inArray } from "drizzle-orm";
import { logger } from "./logger.js";
import { notifyUser } from "./push.js";

// Finds contacts whose follow-up is due today (or overdue) and pushes a
// reminder to the assigned rep. Each contact is notified at most once per
// follow-up date via the `followUpNotifiedOn` marker.
// Local YYYY-MM-DD (NOT UTC). `contacts.followUpDate` is a date-only local-day
// string, so we must compare against the local wall-clock date — toISOString()
// would shift the day across UTC boundaries.
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function runOnce(): Promise<void> {
  const todayStr = localDateStr(new Date());

  const due = await db
    .select({
      id: contactsTable.id,
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

  // One notification per rep, summarising their due follow-ups.
  const byUser = new Map<number, typeof due>();
  for (const c of due) {
    const arr = byUser.get(c.assignedToId!) ?? [];
    arr.push(c);
    byUser.set(c.assignedToId!, arr);
  }

  const notifiedContactIds: number[] = [];
  let notifiedReps = 0;
  for (const [userId, contacts] of byUser) {
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

// Starts the recurring scheduler. Runs shortly after boot, then hourly.
export function startFollowUpScheduler(): void {
  const INTERVAL_MS = 60 * 60 * 1000; // hourly
  const tick = () => {
    runOnce().catch((err) => logger.error({ err }, "Follow-up scheduler tick failed"));
  };
  setTimeout(tick, 15_000);
  setInterval(tick, INTERVAL_MS);
  logger.info("Follow-up notification scheduler started");
}
