import {
  db,
  customFieldDefinitionsTable,
  customFieldValuesTable,
} from "@workspace/db";
import { and, eq, asc, count, inArray, isNull, ne, type SQL } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { activeScope, combine, exec, type Executor } from "./base.js";

export type CustomFieldDefinitionRow = typeof customFieldDefinitionsTable.$inferSelect;
export type CustomFieldValueRow = typeof customFieldValuesTable.$inferSelect;

// ── Definitions ──────────────────────────────────────────────────────────────

export interface ListDefinitionsOpts {
  entityType?: string;
}

export async function listDefinitions(
  user: AuthUser,
  opts: ListDefinitionsOpts,
): Promise<{ rows: CustomFieldDefinitionRow[]; total: number }> {
  const extra: Array<SQL | undefined> = [
    opts.entityType !== undefined ? eq(customFieldDefinitionsTable.entityType, opts.entityType) : undefined,
  ];
  const where = activeScope(user, customFieldDefinitionsTable.companyId, customFieldDefinitionsTable.deletedAt, { extra });
  const rows = await db
    .select()
    .from(customFieldDefinitionsTable)
    .where(where)
    .orderBy(asc(customFieldDefinitionsTable.sortOrder), asc(customFieldDefinitionsTable.id));
  const [{ value: total }] = await db
    .select({ value: count() })
    .from(customFieldDefinitionsTable)
    .where(where);
  return { rows, total };
}

// Tenant-scoped, soft-delete-excluding single fetch (undefined for missing,
// deleted, or inaccessible).
export async function findDefinitionById(
  user: AuthUser,
  id: number,
): Promise<CustomFieldDefinitionRow | undefined> {
  const where = activeScope(user, customFieldDefinitionsTable.companyId, customFieldDefinitionsTable.deletedAt, {
    extra: [eq(customFieldDefinitionsTable.id, id)],
  });
  const [row] = await db.select().from(customFieldDefinitionsTable).where(where).limit(1);
  return row;
}

// Fetch a set of definitions by id within a company (soft-delete excluded).
// Used to validate value-set requests reference live definitions of the entity.
export async function definitionsForEntityType(
  companyId: number,
  entityType: string,
): Promise<CustomFieldDefinitionRow[]> {
  return db
    .select()
    .from(customFieldDefinitionsTable)
    .where(
      and(
        eq(customFieldDefinitionsTable.companyId, companyId),
        eq(customFieldDefinitionsTable.entityType, entityType),
        isNull(customFieldDefinitionsTable.deletedAt),
      ),
    )
    .orderBy(asc(customFieldDefinitionsTable.sortOrder), asc(customFieldDefinitionsTable.id));
}

// Returns the id of a live definition sharing the given fieldKey in the same
// (company, entityType), excluding an optional id (for update). Used to enforce
// fieldKey uniqueness in the service layer (no DB unique to allow key reuse
// after soft-delete).
export async function findKeyConflict(
  companyId: number,
  entityType: string,
  fieldKey: string,
  excludeId?: number,
): Promise<number | undefined> {
  const conds: Array<SQL | undefined> = [
    eq(customFieldDefinitionsTable.companyId, companyId),
    eq(customFieldDefinitionsTable.entityType, entityType),
    eq(customFieldDefinitionsTable.fieldKey, fieldKey),
    isNull(customFieldDefinitionsTable.deletedAt),
    excludeId !== undefined ? ne(customFieldDefinitionsTable.id, excludeId) : undefined,
  ];
  const [row] = await db
    .select({ id: customFieldDefinitionsTable.id })
    .from(customFieldDefinitionsTable)
    .where(combine(...conds))
    .limit(1);
  return row?.id;
}

export async function insertDefinition(
  data: typeof customFieldDefinitionsTable.$inferInsert,
): Promise<CustomFieldDefinitionRow> {
  const [row] = await db.insert(customFieldDefinitionsTable).values(data).returning();
  return row;
}

export async function updateDefinition(
  id: number,
  data: Partial<typeof customFieldDefinitionsTable.$inferInsert>,
): Promise<CustomFieldDefinitionRow | undefined> {
  const [row] = await db
    .update(customFieldDefinitionsTable)
    .set(data)
    .where(eq(customFieldDefinitionsTable.id, id))
    .returning();
  return row;
}

// Soft-delete a definition and hard-delete its values in one transaction (values
// only exist while set — there is no value soft-delete to preserve).
export async function softDeleteDefinition(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(customFieldValuesTable).where(eq(customFieldValuesTable.definitionId, id));
    await tx
      .update(customFieldDefinitionsTable)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(customFieldDefinitionsTable.id, id));
  });
}

// ── Values ───────────────────────────────────────────────────────────────────

// All values for one entity, joined with their (live) definition so the response
// can label + type each value. Values whose definition was soft-deleted are
// excluded (the join drops them).
export async function valuesForEntity(
  companyId: number,
  entityType: string,
  entityId: number,
): Promise<Array<{ value: CustomFieldValueRow; definition: CustomFieldDefinitionRow }>> {
  const rows = await db
    .select({ value: customFieldValuesTable, definition: customFieldDefinitionsTable })
    .from(customFieldValuesTable)
    .innerJoin(
      customFieldDefinitionsTable,
      eq(customFieldValuesTable.definitionId, customFieldDefinitionsTable.id),
    )
    .where(
      and(
        eq(customFieldValuesTable.companyId, companyId),
        eq(customFieldValuesTable.entityType, entityType),
        eq(customFieldValuesTable.entityId, entityId),
        isNull(customFieldDefinitionsTable.deletedAt),
      ),
    )
    .orderBy(asc(customFieldDefinitionsTable.sortOrder), asc(customFieldDefinitionsTable.id));
  return rows;
}

// Batch fetch of raw values for many entities of one type (soft-deleted
// definitions excluded via the join). Used by the Export Center to attach custom
// field columns to every exported row without an N+1 query. Returns flat rows;
// the caller groups by entityId + definitionId.
export async function valuesForEntities(
  companyId: number,
  entityType: string,
  entityIds: number[],
): Promise<Array<{ entityId: number; definitionId: number; value: string | null }>> {
  if (entityIds.length === 0) return [];
  return db
    .select({
      entityId: customFieldValuesTable.entityId,
      definitionId: customFieldValuesTable.definitionId,
      value: customFieldValuesTable.value,
    })
    .from(customFieldValuesTable)
    .innerJoin(
      customFieldDefinitionsTable,
      eq(customFieldValuesTable.definitionId, customFieldDefinitionsTable.id),
    )
    .where(
      and(
        eq(customFieldValuesTable.companyId, companyId),
        eq(customFieldValuesTable.entityType, entityType),
        inArray(customFieldValuesTable.entityId, entityIds),
        isNull(customFieldDefinitionsTable.deletedAt),
      ),
    );
}

// Upsert a single value (insert or update on the (definitionId, entityId) unique
// index). A null value clears the field (delete). Runs on the shared pool or a
// provided tx so the whole set can be atomic.
export async function upsertValue(
  data: {
    companyId: number;
    definitionId: number;
    entityType: string;
    entityId: number;
    value: string | null;
  },
  tx?: Executor,
): Promise<void> {
  const e = exec(tx);
  if (data.value === null) {
    await e
      .delete(customFieldValuesTable)
      .where(
        and(
          eq(customFieldValuesTable.definitionId, data.definitionId),
          eq(customFieldValuesTable.entityId, data.entityId),
        ),
      );
    return;
  }
  await e
    .insert(customFieldValuesTable)
    .values({
      companyId: data.companyId,
      definitionId: data.definitionId,
      entityType: data.entityType,
      entityId: data.entityId,
      value: data.value,
    })
    .onConflictDoUpdate({
      target: [customFieldValuesTable.definitionId, customFieldValuesTable.entityId],
      set: { value: data.value, updatedAt: new Date() },
    });
}

// Apply a resolved set of (definition, value) pairs to one entity atomically:
// upsert non-null values, clear (delete) null values. Used by the value-set path.
export async function upsertValuesTransaction(
  companyId: number,
  entityType: string,
  entityId: number,
  items: Array<{ def: { id: number }; value: string | null }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const item of items) {
      await upsertValue(
        {
          companyId,
          definitionId: item.def.id,
          entityType,
          entityId,
          value: item.value,
        },
        tx,
      );
    }
  });
}

// Bulk import: insert many pre-validated custom-field values in one pass. Accepts
// an executor so the caller can run it inside the same transaction as the base
// entity inserts (import commit atomicity). These are always fresh entities, so a
// plain insert (no upsert) is correct. Chunked to stay under Postgres' bound-
// parameter limit. No-op for an empty list.
export async function bulkInsertValues(
  entries: Array<{ companyId: number; definitionId: number; entityType: string; entityId: number; value: string }>,
  tx?: Executor,
): Promise<void> {
  if (entries.length === 0) return;
  const e = exec(tx);
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await e.insert(customFieldValuesTable).values(entries.slice(i, i + CHUNK));
  }
}

// Delete all values for a set of entities (used when the owning entity is deleted
// or merged away). No-op for an empty id list.
export async function deleteValuesForEntities(
  entityType: string,
  entityIds: number[],
  tx?: Executor,
): Promise<void> {
  if (entityIds.length === 0) return;
  await exec(tx)
    .delete(customFieldValuesTable)
    .where(
      and(
        eq(customFieldValuesTable.entityType, entityType),
        inArray(customFieldValuesTable.entityId, entityIds),
      ),
    );
}
