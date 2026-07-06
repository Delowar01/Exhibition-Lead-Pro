import {
  db,
  documentsTable,
  documentVersionsTable,
  usersTable,
  companiesTable,
  contactsTable,
  eventsTable,
  leadsTable,
} from "@workspace/db";
import { eq, and, count, desc, ilike, or, gte, lte, inArray, max, sql, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, combine, type Executor } from "./base.js";

export type DocumentRow = typeof documentsTable.$inferSelect;
export type DocumentVersionRow = typeof documentVersionsTable.$inferSelect;

export interface ListDocumentsOpts {
  entityType?: string;
  entityId?: number;
  category?: string;
  mimeType?: string;
  uploadedBy?: number;
  q?: string;
  from?: string;
  to?: string;
  includeDeleted?: boolean;
  limit: number;
  offset: number;
}

// A document row joined with its current version (left join — a document always
// has a current version once created, but the join stays defensive).
export interface DocumentWithVersion {
  doc: DocumentRow;
  currentVersion: DocumentVersionRow | null;
}

function selectWithVersion() {
  return db
    .select({ doc: documentsTable, version: documentVersionsTable })
    .from(documentsTable)
    .leftJoin(documentVersionsTable, eq(documentsTable.currentVersionId, documentVersionsTable.id));
}

// ── Tenant-scoped, soft-delete-excluding list with filters + free-text search.
export async function list(user: AuthUser, opts: ListDocumentsOpts): Promise<{ rows: DocumentWithVersion[]; total: number }> {
  const extra: Array<SQL | undefined> = [
    opts.entityType !== undefined ? eq(documentsTable.entityType, opts.entityType) : undefined,
    opts.entityId !== undefined ? eq(documentsTable.entityId, opts.entityId) : undefined,
    opts.category !== undefined ? eq(documentsTable.category, opts.category) : undefined,
    opts.mimeType !== undefined ? eq(documentVersionsTable.mimeType, opts.mimeType) : undefined,
    opts.uploadedBy !== undefined ? eq(documentVersionsTable.uploadedById, opts.uploadedBy) : undefined,
    opts.from !== undefined ? gte(documentsTable.createdAt, new Date(opts.from)) : undefined,
    opts.to !== undefined ? lte(documentsTable.createdAt, new Date(opts.to)) : undefined,
    opts.q !== undefined && opts.q.trim() !== ""
      ? or(
          ilike(documentsTable.name, `%${opts.q}%`),
          ilike(documentsTable.description, `%${opts.q}%`),
          ilike(documentVersionsTable.fileName, `%${opts.q}%`),
        )
      : undefined,
  ];
  const where = activeScope(user, documentsTable.companyId, documentsTable.deletedAt, { includeDeleted: opts.includeDeleted, extra });

  const totalRows = await db
    .select({ total: count() })
    .from(documentsTable)
    .leftJoin(documentVersionsTable, eq(documentsTable.currentVersionId, documentVersionsTable.id))
    .where(where);
  const total = totalRows[0]?.total ?? 0;

  const rows = await selectWithVersion()
    .where(where)
    .limit(opts.limit)
    .offset(opts.offset)
    .orderBy(desc(documentsTable.createdAt));

  return { rows: rows.map((r) => ({ doc: r.doc, currentVersion: r.version })), total };
}

// Documents attached to ANY of an org's contacts or leads (Company Detail
// aggregate). Tenant-scoped + soft-delete-excluding; newest first.
export async function listForOrg(user: AuthUser, contactIds: number[], leadIds: number[]): Promise<DocumentWithVersion[]> {
  if (contactIds.length === 0 && leadIds.length === 0) return [];
  const targets: SQL[] = [];
  if (contactIds.length > 0) targets.push(and(eq(documentsTable.entityType, "contact"), inArray(documentsTable.entityId, contactIds))!);
  if (leadIds.length > 0) targets.push(and(eq(documentsTable.entityType, "lead"), inArray(documentsTable.entityId, leadIds))!);
  const where = activeScope(user, documentsTable.companyId, documentsTable.deletedAt, { extra: [or(...targets)!] });
  const rows = await selectWithVersion().where(where).orderBy(desc(documentsTable.createdAt));
  return rows.map((r) => ({ doc: r.doc, currentVersion: r.version }));
}

// Tenant-scoped single fetch. Pass includeDeleted=true for the restore path.
export async function findById(user: AuthUser, id: number, includeDeleted = false): Promise<DocumentWithVersion | undefined> {
  const where = activeScope(user, documentsTable.companyId, documentsTable.deletedAt, {
    includeDeleted,
    extra: [eq(documentsTable.id, id)],
  });
  const [row] = await selectWithVersion().where(where).limit(1);
  return row ? { doc: row.doc, currentVersion: row.version } : undefined;
}

// All versions of a document (newest first) with uploader name resolved.
export async function versionsForDocument(documentId: number) {
  return db
    .select({
      id: documentVersionsTable.id,
      documentId: documentVersionsTable.documentId,
      versionNumber: documentVersionsTable.versionNumber,
      label: documentVersionsTable.label,
      objectPath: documentVersionsTable.objectPath,
      fileName: documentVersionsTable.fileName,
      fileSize: documentVersionsTable.fileSize,
      mimeType: documentVersionsTable.mimeType,
      uploadedById: documentVersionsTable.uploadedById,
      uploadedByName: usersTable.name,
      uploadedAt: documentVersionsTable.uploadedAt,
    })
    .from(documentVersionsTable)
    .leftJoin(usersTable, eq(documentVersionsTable.uploadedById, usersTable.id))
    .where(eq(documentVersionsTable.documentId, documentId))
    .orderBy(desc(documentVersionsTable.versionNumber));
}

// A specific version, tenant-scoped by the denormalized companyId and bound to
// its document. Returns undefined when missing / out of tenant / wrong document.
export async function versionById(user: AuthUser, documentId: number, versionId: number): Promise<DocumentVersionRow | undefined> {
  const where = combine(
    eq(documentVersionsTable.id, versionId),
    eq(documentVersionsTable.documentId, documentId),
    // tenant scope on the denormalized companyId
    user.role === "platform_owner" ? undefined : inArray(documentVersionsTable.companyId, user.accessibleCompanies),
  );
  const [row] = await db.select().from(documentVersionsTable).where(where).limit(1);
  return row;
}

export async function versionCountsByIds(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ documentId: documentVersionsTable.documentId, total: count() })
    .from(documentVersionsTable)
    .where(inArray(documentVersionsTable.documentId, ids))
    .groupBy(documentVersionsTable.documentId);
  return new Map(rows.map((r) => [r.documentId, r.total]));
}

export async function userNamesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, ids));
}

// Resolve display names for attach targets of a single entity type (batched).
export async function entityNames(entityType: string, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const unique = [...new Set(ids)];
  if (entityType === "company") {
    const rows = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  if (entityType === "contact") {
    const rows = await db.select({ id: contactsTable.id, fullName: contactsTable.fullName }).from(contactsTable).where(inArray(contactsTable.id, unique));
    return new Map(rows.map((r) => [r.id, r.fullName ?? `Contact #${r.id}`]));
  }
  if (entityType === "event") {
    const rows = await db.select({ id: eventsTable.id, name: eventsTable.name }).from(eventsTable).where(inArray(eventsTable.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  if (entityType === "lead") {
    const rows = await db.select({ id: leadsTable.id, title: leadsTable.title }).from(leadsTable).where(inArray(leadsTable.id, unique));
    return new Map(rows.map((r) => [r.id, r.title ?? `Opportunity #${r.id}`]));
  }
  return new Map();
}

// Create a document and its first version atomically, then point the document at
// that version. Returns the created document row.
export async function insertWithFirstVersion(
  docValues: Omit<typeof documentsTable.$inferInsert, "currentVersionId">,
  versionValues: Omit<typeof documentVersionsTable.$inferInsert, "documentId" | "versionNumber">,
): Promise<DocumentRow> {
  return db.transaction(async (tx) => {
    const [doc] = await tx.insert(documentsTable).values(docValues).returning();
    const [version] = await tx
      .insert(documentVersionsTable)
      .values({ ...versionValues, documentId: doc.id, versionNumber: 1 })
      .returning();
    const [updated] = await tx
      .update(documentsTable)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(documentsTable.id, doc.id))
      .returning();
    return updated;
  });
}

// Append a new immutable version (never overwrites) and repoint the document's
// currentVersionId. versionNumber is max+1 computed inside the transaction.
// Arbitrary namespace key for the per-document advisory lock (keeps it from
// colliding with advisory locks used elsewhere).
const DOC_VERSION_LOCK_NS = 74013;

export async function addVersion(
  documentId: number,
  versionValues: Omit<typeof documentVersionsTable.$inferInsert, "documentId" | "versionNumber">,
): Promise<DocumentVersionRow> {
  return db.transaction(async (tx) => {
    // Serialize concurrent version inserts for THIS document via a transaction-
    // scoped advisory lock (released at commit). This makes the max+1 read/insert
    // deterministic so parallel uploads get distinct monotonic numbers; the unique
    // (document_id, version_number) index remains as a hard backstop.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DOC_VERSION_LOCK_NS}, ${documentId})`);
    const [{ maxNum }] = await tx
      .select({ maxNum: max(documentVersionsTable.versionNumber) })
      .from(documentVersionsTable)
      .where(eq(documentVersionsTable.documentId, documentId));
    const nextNumber = (maxNum ?? 0) + 1;
    const [version] = await tx
      .insert(documentVersionsTable)
      .values({ ...versionValues, documentId, versionNumber: nextNumber })
      .returning();
    await tx
      .update(documentsTable)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(documentsTable.id, documentId));
    return version;
  });
}

export async function update(id: number, updateData: Partial<typeof documentsTable.$inferInsert>): Promise<DocumentRow | undefined> {
  const [row] = await db
    .update(documentsTable)
    .set({ ...updateData, updatedAt: new Date() })
    .where(eq(documentsTable.id, id))
    .returning();
  return row;
}

// Soft-delete: stamp deletedAt. Versions are retained (they cascade only on a
// hard delete) and become unreachable once the parent document is hidden.
export async function softDelete(id: number, tx?: Executor): Promise<void> {
  const run = async (t: Executor) => {
    await t.update(documentsTable).set({ deletedAt: new Date() }).where(eq(documentsTable.id, id));
  };
  if (tx) return run(tx);
  await db.transaction(run);
}

export async function restore(id: number): Promise<DocumentRow | undefined> {
  const [row] = await db
    .update(documentsTable)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(documentsTable.id, id))
    .returning();
  return row;
}
