// B25 Correction 2 — storage errors are SANITIZED before they are logged,
// persisted or returned. Injected provider / filesystem / database errors carry
// distinctive secrets (bucket + object names, host paths, passwords, a signed
// URL, SQL parameters); none of them may reach the captured logs, the persisted
// last_error, the migration failure report or an API error.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable, documentsTable, documentVersionsTable, scansTable } from "@workspace/db";
import { config } from "../src/config.js";
import { logger } from "../src/lib/logger.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { sanitizeStorageError } from "../src/storage/log-safety.js";
import { reportMigrationFailure } from "../src/storage/migration-cli.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as scansRepo from "../src/repositories/scans.repository.js";
import * as storage from "../src/services/storage.service.js";
import { putLogo } from "../src/lib/branding/storage.js";
import { storeAndBindScanImage } from "../src/services/scans.service.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});
vi.mock("../src/repositories/scans.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/scans.repository.js")>();
  return { ...actual, bindImage: vi.fn(actual.bindImage) };
});

const SECRETS = [
  "gs://secret-bucket/private-object",
  "/opt/private/storage/company-42",
  "password=hunter2-secret",
  "https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeefsig",
  "params=[\"tenant-secret-row\"]",
  "Bearer eyJ-secret-token",
];
function secretError(kind: "provider" | "fs" | "db" | "signed" | "plain"): Error {
  switch (kind) {
    case "provider":
      return Object.assign(new Error(`Upload to ${SECRETS[0]} failed: ${SECRETS[2]} ${SECRETS[3]}`), { code: 503, response: { body: `{"error":"${SECRETS[0]}"}` }, config: { headers: { Authorization: SECRETS[5] } } });
    case "fs":
      return Object.assign(new Error(`EACCES: permission denied, open '${SECRETS[1]}/tenants/42/x'`), { code: "EACCES", path: `${SECRETS[1]}/tenants/42/x`, syscall: "open" });
    case "db":
      return Object.assign(new Error(`connection terminated; query: UPDATE storage_objects SET state=$1 WHERE id=$2 ${SECRETS[4]} ${SECRETS[2]}`), { code: "57P01", severity: "FATAL", detail: SECRETS[4], query: "UPDATE storage_objects ...", parameters: ["tenant-secret-row"] });
    case "signed":
      return new Error(`signed request failed ${SECRETS[3]}`);
    default:
      return new Error(`${SECRETS[1]} ${SECRETS[0]} ${SECRETS[2]}`);
  }
}
/** Serialize the way pino's err serializer would: message, stack, cause and enumerable properties of every Error. */
function dump(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack, cause: (v as { cause?: unknown }).cause, ...v } : v));
}
function expectNoSecret(text: string, where: string) {
  for (const s of SECRETS) expect(text, `${where} leaked ${s}`).not.toContain(s);
}

describe("10a. sanitizeStorageError", () => {
  it("keeps only a stable code, class, reason and retryable flag — never message, cause, stack, paths, keys or SQL", () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [new StorageError("STORAGE_UNAVAILABLE", `mirror ${SECRETS[0]}`, secretError("provider"), "MIRROR_FAILED"), { class: "StorageError", code: "STORAGE_UNAVAILABLE", reason: "MIRROR_FAILED", retryable: true }],
      [secretError("provider"), { class: "ProviderError", status: 503, retryable: true }],
      [secretError("fs"), { class: "SystemError", code: "EACCES" }],
      [secretError("db"), { class: "DatabaseError", code: "57P01" }],
      [secretError("signed"), { class: "Error" }],
      [new AppError(503, `oops ${SECRETS[1]}`, { code: "STORAGE_UNAVAILABLE" }), { class: "AppError", status: 503, code: "STORAGE_UNAVAILABLE" }],
      [SECRETS[0], { class: "string" }],
      [null, { class: "null" }],
    ];
    for (const [err, expected] of cases) {
      const out = sanitizeStorageError(err);
      expect(out).toMatchObject(expected);
      expectNoSecret(dump(out), "sanitizer output");
      expect(Object.keys(out).sort()).toEqual(expect.arrayContaining(["class"]));
      expect("message" in out || "stack" in out || "cause" in out).toBe(false);
    }
  });
});

describe("10b. captured logs, persisted errors and API errors carry no secret", () => {
  const os = config.objectStorage as unknown as { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean };
  const original = { ...os };
  let COMPANY = 0;
  let primary: MemoryStorageDriver;
  let gcs: MemoryStorageDriver;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  let logged: unknown[][] = [];

  function captured(): string {
    return dump(logged);
  }

  beforeAll(async () => {
    os.driver = "memory";
    os.bucketId = "fake-bucket";
    os.privateObjectDir = "/fake-bucket/.private";
    os.legacyFallback = false;
    os.mirror = false;
    os.legacyDelete = false;
    const [c] = await db.insert(companiesTable).values({ name: `B25C2 logs ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
    COMPANY = c.id;
    for (const level of ["warn", "error", "info", "debug"] as const) {
      spies.push(vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never));
    }
  });
  afterAll(async () => {
    Object.assign(os, original);
    __resetStorageRegistryForTests();
    for (const s of spies) s.mockRestore();
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    await db.delete(scansTable).where(eq(scansTable.companyId, COMPANY));
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, COMPANY));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, COMPANY));
    await db.delete(companiesTable).where(eq(companiesTable.id, COMPANY));
  });
  beforeEach(async () => {
    __resetStorageRegistryForTests();
    primary = new MemoryStorageDriver();
    gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
    __setDriversForTests({ primary, legacy: gcs });
    os.mirror = false;
    os.legacyFallback = false;
    logged = [];
    vi.mocked(repo.transition).mockReset();
    vi.mocked(repo.transition).mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
      return actual.transition(...args);
    });
    vi.mocked(scansRepo.bindImage).mockReset();
    vi.mocked(scansRepo.bindImage).mockImplementation(async (...args) => {
      const actual = await vi.importActual<typeof import("../src/repositories/scans.repository.js")>("../src/repositories/scans.repository.js");
      return actual.bindImage(...args);
    });
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  });

  async function lastErrors(): Promise<string> {
    const rows = await db.select({ lastError: storageObjectsTable.lastError }).from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    return rows.map((r) => r.lastError ?? "").join("\n");
  }

  it("primary write failure (provider error with bucket, password and signed URL)", async () => {
    primary.failNextPutWith = secretError("provider");
    const err = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("x") }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expectNoSecret(dump({ message: (err as Error).message, code: (err as StorageError).code }), "thrown error");
    expectNoSecret(storage.toAppError(err).message, "API error");
    expectNoSecret(captured(), "logs");
    expectNoSecret(await lastErrors(), "last_error");
    expect(logged.length).toBeGreaterThan(0);
    expect(captured()).toMatch(/"code":"STORAGE_UNAVAILABLE"|"class":"ProviderError"/);
  });

  it("mirror write failure (filesystem path) and rollback delete failure", async () => {
    os.mirror = true;
    gcs.failNextPutWith = secretError("fs");
    primary.failNextDeleteWith = secretError("plain");
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("x") })).rejects.toBeInstanceOf(StorageError);
    expectNoSecret(captured(), "logs");
    expectNoSecret(await lastErrors(), "last_error");
    expect(await lastErrors()).toContain("CLEANUP_PENDING");
  });

  it("database failure after the write (SQL parameters)", async () => {
    vi.mocked(repo.transition).mockRejectedValueOnce(secretError("db"));
    await expect(storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("x") })).rejects.toBeInstanceOf(Error);
    expectNoSecret(captured(), "logs");
    expectNoSecret(await lastErrors(), "last_error");
    expect(primary.objects.size).toBe(0);
  });

  it("legacy lookup failure during a fallback read", async () => {
    os.legacyFallback = true;
    const reference = `/objects/uploads/${randomUUID()}`;
    const [doc] = await db.insert(documentsTable).values({ companyId: COMPANY, entityType: "company", entityId: COMPANY, name: "legacy", category: "Company Profile" }).returning({ id: documentsTable.id });
    await db.insert(documentVersionsTable).values({ companyId: COMPANY, documentId: doc.id, versionNumber: 1, objectPath: reference, fileName: "l.pdf", fileSize: 1, mimeType: "application/pdf" });
    gcs.failNextHeadWith = secretError("provider");
    expect(await storage.openByReference({ companyId: COMPANY, kind: "document", reference })).toBeNull();
    expectNoSecret(captured(), "logs");
  });

  it("branding logo write failure and scan-image bind failure with a failing cleanup", async () => {
    primary.failNextPutWith = secretError("signed");
    await expect(putLogo(COMPANY, Buffer.from("png"), "image/png", "png")).rejects.toMatchObject({ code: "BRANDING_STORAGE_UNAVAILABLE" });
    expectNoSecret(captured(), "logs");

    const [scan] = await db.insert(scansTable).values({ companyId: COMPANY, userId: null, status: "completed", imageUrl: null } as never).returning({ id: scansTable.id });
    vi.mocked(scansRepo.bindImage).mockRejectedValueOnce(secretError("db"));
    primary.failNextDeleteWith = secretError("fs");
    const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0x43, 0]).toString("base64")}`;
    await expect(storeAndBindScanImage({ scanId: scan.id, companyId: COMPANY, imageData: jpegDataUrl })).rejects.toBeInstanceOf(Error);
    expectNoSecret(captured(), "logs");
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("the migration command's fatal report", () => {
    reportMigrationFailure(secretError("db"));
    reportMigrationFailure(new StorageError("STORAGE_UNAVAILABLE", `bucket ${SECRETS[0]}`, secretError("provider")));
    expectNoSecret(captured(), "logs");
    expect(captured()).toContain("migrate-storage failed");
  });
  void inArray;
});
