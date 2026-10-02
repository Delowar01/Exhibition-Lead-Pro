// B25 Correction 2 — company deletion fails CLOSED when a stored file reference
// cannot be inventoried: an unattributable (unsupported / malformed) non-null
// legacy reference, or a native handle with no inventory row, aborts the whole
// deletion transaction with a stable sanitized code, leaves the company and its
// feature rows in place, commits no partial tombstones and enqueues no purge.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, companiesTable, scansTable, storageObjectsTable, documentsTable, documentVersionsTable } from "@workspace/db";
import { config } from "../src/config.js";
import * as storage from "../src/services/storage.service.js";
import { deleteCompany } from "../src/services/companies.service.js";
import { __resetStorageRegistryForTests } from "../src/storage/registry.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/services/storage.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/storage.service.js")>();
  return { ...actual, enqueueCompanyPurge: vi.fn(actual.enqueueCompanyPurge) };
});

const os = config.objectStorage as unknown as { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean };
const original = { ...os };
const companies: number[] = [];
const owner: AuthUser = { id: 1, email: "owner@t", name: "Owner", role: "platform_owner", companyId: null, permissions: {}, contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true, companyStatus: "active", readOnly: false, accessibleCompanies: [], sessionId: null };
const UNSUPPORTED_REFERENCE = "https://cdn.example.invalid/private/company-42/legacy-card.jpg";

async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C2 deletion ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companies.push(c.id);
  return c.id;
}

beforeAll(() => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.mirror = false;
  __resetStorageRegistryForTests();
});
afterAll(async () => {
  Object.assign(os, original);
  __resetStorageRegistryForTests();
  if (companies.length) {
    await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.companyId, companies));
    await db.delete(scansTable).where(inArray(scansTable.companyId, companies));
    await db.delete(documentVersionsTable).where(inArray(documentVersionsTable.companyId, companies));
    await db.delete(documentsTable).where(inArray(documentsTable.companyId, companies));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
  }
});

describe("9. company deletion fails closed on unattributable references", () => {
  it("an unsupported non-null legacy reference aborts the deletion with STORAGE_INVENTORY_INCOMPLETE (sanitized), leaving everything in place", async () => {
    const cid = await newCompany("unattributable");
    const [scan] = await db.insert(scansTable).values({ companyId: cid, userId: null, status: "completed", imageUrl: UNSUPPORTED_REFERENCE } as never).returning({ id: scansTable.id });
    vi.mocked(storage.enqueueCompanyPurge).mockClear();

    let caught: unknown;
    try {
      await deleteCompany(owner, cid);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> };
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("STORAGE_INVENTORY_INCOMPLETE");
    expect(e.details).toMatchObject({ unattributable: 1, kinds: { scan_image: 1 } });
    const serialized = JSON.stringify({ message: e.message, code: e.code, details: e.details });
    expect(serialized).not.toContain("cdn.example.invalid");
    expect(serialized).not.toContain("company-42");
    expect(serialized).not.toContain("legacy-card");

    // nothing was deleted, nothing was partially committed, nothing was enqueued
    expect((await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, cid))).length).toBe(1);
    expect((await db.select({ id: scansTable.id }).from(scansTable).where(eq(scansTable.id, scan.id))).length).toBe(1);
    expect(await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid))).toEqual([]);
    expect(vi.mocked(storage.enqueueCompanyPurge)).not.toHaveBeenCalled();
  });

  it("a native handle without an inventory row (untracked object) is refused the same way", async () => {
    const cid = await newCompany("untracked-native");
    const [doc] = await db.insert(documentsTable).values({ companyId: cid, entityType: "company", entityId: cid, name: "untracked", category: "Company Profile" }).returning({ id: documentsTable.id });
    await db.insert(documentVersionsTable).values({ companyId: cid, documentId: doc.id, versionNumber: 1, objectPath: `/objects/${randomUUID()}`, fileName: "u.pdf", fileSize: 1, mimeType: "application/pdf" });
    vi.mocked(storage.enqueueCompanyPurge).mockClear();
    await expect(deleteCompany(owner, cid)).rejects.toMatchObject({ statusCode: 409, code: "STORAGE_INVENTORY_INCOMPLETE", details: { unattributable: 1, kinds: { document: 1 } } });
    expect((await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, cid))).length).toBe(1);
    expect(await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid))).toEqual([]);
    expect(vi.mocked(storage.enqueueCompanyPurge)).not.toHaveBeenCalled();
  });

  it("a company whose references are all attributable still deletes (control)", async () => {
    const cid = await newCompany("attributable");
    await db.insert(scansTable).values({ companyId: cid, userId: null, status: "completed", imageUrl: `scans/${cid}/1.jpg` } as never);
    vi.mocked(storage.enqueueCompanyPurge).mockResolvedValueOnce(undefined);
    await expect(deleteCompany(owner, cid)).resolves.toMatchObject({ success: true });
    expect((await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, cid))).length).toBe(0);
    const tombstones = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, cid));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].state).toBe("deleting");
    expect(vi.mocked(storage.enqueueCompanyPurge)).toHaveBeenCalledWith(cid);
  });
});
