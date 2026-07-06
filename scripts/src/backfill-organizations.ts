// One-time, idempotent backfill: promotes the legacy free-text company labels
// (contacts.contactCompany, leads.companyName) into first-class CRM `organizations`
// rows and links the originating contacts/leads via the new nullable organizationId FK.
//
// Safe to re-run: organizations are matched/created per tenant by (companyId,
// normalizedName); only contacts/leads whose organizationId is still NULL are linked.
// No fabricated data — every organization created is derived from a real, non-empty
// company label already present on a contact or lead in that tenant.
import { db, organizationsTable, contactsTable, leadsTable } from "@workspace/db";
import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function findOrCreateOrg(companyId: number, label: string): Promise<number> {
  const name = label.trim();
  const normalizedName = normalizeName(name);
  const existing = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(and(eq(organizationsTable.companyId, companyId), eq(organizationsTable.normalizedName, normalizedName), isNull(organizationsTable.deletedAt)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await db.insert(organizationsTable).values({ companyId, name, normalizedName, status: "active" }).returning({ id: organizationsTable.id });
  return row.id;
}

async function backfill(): Promise<void> {
  // Distinct tenant + free-text company pairs from contacts.
  const contactLabels = await db
    .selectDistinct({ companyId: contactsTable.companyId, label: contactsTable.contactCompany })
    .from(contactsTable)
    .where(and(isNull(contactsTable.deletedAt), isNull(contactsTable.organizationId), isNotNull(contactsTable.contactCompany)));

  const leadLabels = await db
    .selectDistinct({ companyId: leadsTable.companyId, label: leadsTable.companyName })
    .from(leadsTable)
    .where(and(isNull(leadsTable.deletedAt), isNull(leadsTable.organizationId), isNotNull(leadsTable.companyName)));

  let orgsTouched = 0;
  let contactsLinked = 0;
  let leadsLinked = 0;

  for (const { companyId, label } of contactLabels) {
    if (!label || !label.trim()) continue;
    const orgId = await findOrCreateOrg(companyId, label);
    orgsTouched++;
    const res = await db
      .update(contactsTable)
      .set({ organizationId: orgId })
      .where(and(eq(contactsTable.companyId, companyId), eq(contactsTable.contactCompany, label), isNull(contactsTable.deletedAt), isNull(contactsTable.organizationId)))
      .returning({ id: contactsTable.id });
    contactsLinked += res.length;
  }

  for (const { companyId, label } of leadLabels) {
    if (!label || !label.trim()) continue;
    const orgId = await findOrCreateOrg(companyId, label);
    const res = await db
      .update(leadsTable)
      .set({ organizationId: orgId })
      .where(and(eq(leadsTable.companyId, companyId), eq(leadsTable.companyName, label), isNull(leadsTable.deletedAt), isNull(leadsTable.organizationId)))
      .returning({ id: leadsTable.id });
    leadsLinked += res.length;
  }

  const [{ count: totalOrgs }] = await db.select({ count: sql<number>`count(*)::int` }).from(organizationsTable);
  console.log(`Backfill complete. Orgs created/matched this run: ${orgsTouched}; contacts linked: ${contactsLinked}; leads linked: ${leadsLinked}; total organizations now: ${totalOrgs}.`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
