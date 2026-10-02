// B25 Correction 3 — COMPLETE storage log containment. A storage-origin error
// is translated into a safe StorageError / AppError (fixed message, sanitized
// cause summary, no raw cause) BEFORE it can reach any generic logger, and every
// remaining raw-error log site on a storage path is sanitized:
//   • StorageError never retains a raw cause (pino serializes cause chains)
//   • branding previous-logo / removal / reset cleanup logs
//   • startup object-storage initialization failure log
//   • the global request error handler for an upload whose staging database
//     transition fails (request log + API response)
//   • the in-process job runner's failure log for a server-side activation failure
//   • persisted last_error values
// Injected secrets: bucket + object name, host path, password, bearer token,
// signed URL, SQL text + parameters — serialized the way pino's err serializer
// would (message, stack, cause chain, enumerable properties, request bodies).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Request, Response } from "express";
import { db, storageObjectsTable, companiesTable, auditLogsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { logger } from "../src/lib/logger.js";
import { AppError, errorHandler } from "../src/middlewares/errorHandler.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests, reportStorageInitFailure, StorageConfigError } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { uploadLogo, removeLogo, resetBranding } from "../src/services/branding.service.js";
import { InProcessQueue } from "../src/lib/jobs/in-process-queue.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition), releaseUpload: vi.fn(actual.releaseUpload) };
});

const SECRETS = [
  "gs://secret-bucket/private-object",
  "/opt/private/storage/company-42",
  "password=hunter2-secret",
  "Bearer eyJ-secret-token",
  "https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeefsig",
  "params=[\"tenant-secret-row\"]",
  "UPDATE storage_objects SET state=$1",
];
function secretError(kind: "provider" | "fs" | "db" | "plain"): Error {
  switch (kind) {
    case "provider":
      return Object.assign(new Error(`Upload to ${SECRETS[0]} failed: ${SECRETS[2]} ${SECRETS[4]}`), { code: 503, response: { body: `{"error":"${SECRETS[0]}"}` }, config: { headers: { Authorization: SECRETS[3] }, body: SECRETS[2] } });
    case "fs":
      return Object.assign(new Error(`EACCES: permission denied, open '${SECRETS[1]}/tenants/42/x'`), { code: "EACCES", path: `${SECRETS[1]}/tenants/42/x`, dest: `${SECRETS[1]}/tenants/42/y`, syscall: "open" });
    case "db":
      return Object.assign(new Error(`connection terminated; query: ${SECRETS[6]} WHERE id=$2 ${SECRETS[5]} ${SECRETS[2]}`), { code: "57P01", severity: "FATAL", detail: SECRETS[5], query: SECRETS[6], parameters: ["tenant-secret-row"] });
    default:
      return new Error(`${SECRETS[1]} ${SECRETS[0]} ${SECRETS[2]} ${SECRETS[3]}`);
  }
}
function withCause(err: Error, cause: unknown): Error {
  return Object.assign(err, { cause });
}
/** pino-style serialization: message, stack, the whole cause chain and every enumerable property of every Error. */
function dump(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (v instanceof Error) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      return { name: v.name, message: v.message, stack: v.stack, cause: (v as { cause?: unknown }).cause, ...v };
    }
    return v;
  });
}
function expectNoSecret(text: string, where: string) {
  for (const s of SECRETS) expect(text, `${where} leaked ${s}`).not.toContain(s);
}

const os = config.objectStorage as unknown as { driver: string; bucketId: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean };
const original = { ...os };
let COMPANY = 0;
let primary: MemoryStorageDriver;
let gcs: MemoryStorageDriver;
let logged: unknown[][] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
let user: AuthUser;
const png = () => sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
const fakeReq = () => ({ ip: "127.0.0.1", user, headers: {}, get: () => undefined }) as unknown as Request;
function captured(): string {
  return dump(logged);
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.legacyFallback = false;
  os.mirror = false;
  os.legacyDelete = false;
  const [c] = await db.insert(companiesTable).values({ name: `B25C3 logs ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  COMPANY = c.id;
  user = { id: 1, email: "u@t", name: "U", role: "primary_admin", companyId: COMPANY, permissions: {}, contactVisibility: "all", companyVisibility: "all", selectedUserIds: [], isActive: true, companyStatus: "active", readOnly: false, accessibleCompanies: [COMPANY], sessionId: null };
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
  await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, COMPANY));
  await db.delete(companiesTable).where(eq(companiesTable.id, COMPANY));
});
beforeEach(async () => {
  __resetStorageRegistryForTests();
  primary = new MemoryStorageDriver();
  gcs = new MemoryStorageDriver({ looseKeys: true, kind: "gcs" });
  __setDriversForTests({ primary, legacy: gcs });
  os.mirror = false;
  logged = [];
  for (const fn of [repo.transition, repo.releaseUpload] as const) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(repo.transition).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.transition(...args);
  });
  vi.mocked(repo.releaseUpload).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    return actual.releaseUpload(...args);
  });
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
});
async function lastErrors(): Promise<string> {
  const rows = await db.select({ lastError: storageObjectsTable.lastError }).from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  return rows.map((r) => r.lastError ?? "").join("\n");
}

describe("C. storage-origin errors never reach a logger, a row or a response with their secrets", () => {
  it("1. StorageError keeps no raw cause: only a sanitized cause summary survives pino-style serialization", () => {
    const err = new StorageError("STORAGE_UNAVAILABLE", "mirror write failed", withCause(secretError("provider"), secretError("db")), "MIRROR_FAILED");
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect(err.causeInfo).toMatchObject({ class: "ProviderError", status: 503 });
    expectNoSecret(dump({ err }), "StorageError");
    expectNoSecret(dump(err), "StorageError (bare)");
  });

  it("2. branding: previous-logo cleanup, removal cleanup and reset cleanup log sanitized errors when the tombstone transition fails", async () => {
    const actual = await vi.importActual<typeof import("../src/repositories/storage-objects.repository.js")>("../src/repositories/storage-objects.repository.js");
    const first = await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    expect(first.logoUrl).toBeTruthy();
    // the new logo activates (first transition), then the PREVIOUS logo's tombstone transition fails
    vi.mocked(repo.transition).mockImplementationOnce(actual.transition).mockRejectedValueOnce(withCause(secretError("db"), secretError("fs")));
    await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    vi.mocked(repo.transition).mockRejectedValueOnce(secretError("db"));
    await removeLogo(fakeReq(), COMPANY);
    await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    vi.mocked(repo.transition).mockImplementationOnce(actual.transition).mockRejectedValueOnce(secretError("provider"));
    await resetBranding(fakeReq(), COMPANY);
    expect(logged.length).toBeGreaterThanOrEqual(3);
    expectNoSecret(captured(), "branding cleanup logs");
    expect(captured()).toMatch(/Branding: (previous logo|logo) object could not be deleted/);
  });

  it("3. startup: an object-storage initialization failure is logged without paths or provider details; a configuration problem keeps its fixed reason", () => {
    reportStorageInitFailure(withCause(secretError("fs"), secretError("provider")));
    reportStorageInitFailure(new StorageConfigError("OBJECT_STORAGE_FS_ROOT must be an absolute path"));
    expectNoSecret(captured(), "startup logs");
    expect(captured()).toContain("OBJECT_STORAGE_FS_ROOT must be an absolute path");
    expect(captured()).toContain("Object storage initialization failed");
  });

  it("4. an upload whose staging database transition fails: the request error log and the API response carry no secret", async () => {
    const r = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 100 });
    const dbErr = withCause(secretError("db"), secretError("provider"));
    vi.mocked(repo.releaseUpload).mockRejectedValueOnce(dbErr).mockRejectedValueOnce(dbErr);
    let thrown: unknown;
    try {
      await storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([Buffer.from("payload")]));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(503);
    expectNoSecret(dump(thrown), "thrown upload error");

    // the global handler, exactly as Express would invoke it for this request
    const requestLog: unknown[][] = [];
    const req = { id: "req-1", log: { error: (...args: unknown[]) => requestLog.push(args) }, body: { note: "request body must not be echoed either" } } as unknown as Request;
    let body: unknown;
    let status = 0;
    const res = { headersSent: false, setHeader: () => undefined, status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response;
    errorHandler(thrown, req, res, () => undefined);
    expect(status).toBe(503);
    expectNoSecret(dump(requestLog), "request error log");
    expectNoSecret(dump(body), "API response");
    expect(dump(body)).toContain("STORAGE_UNAVAILABLE");
    expectNoSecret(await lastErrors(), "last_error");
    // the rollback's own release hit the same database failure: the copy is left for the durable lease-expiry sweep
    await storage.sweepStorage(new Date(Date.now() + config.objectStorage.uploadLeaseMs + 1000));
    expect(primary.objects.size).toBe(0);
    expectNoSecret(captured(), "sweep logs");
  });

  it("5. a server-side activation failure inside a job: the in-process runner's failure log carries no secret", async () => {
    const queue = new InProcessQueue({ driver: "in-process", concurrency: 1, maxAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 1 });
    let settled!: () => void;
    const done = new Promise<void>((r) => (settled = r));
    queue.register("test.storeReport", async () => {
      vi.mocked(repo.transition).mockRejectedValueOnce(withCause(secretError("db"), secretError("fs")));
      try {
        await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pdf") });
      } finally {
        setTimeout(settled, 0);
      }
    });
    queue.start();
    await queue.enqueue("test.storeReport", {}, { maxAttempts: 1 });
    await done;
    await new Promise((r) => setImmediate(r));
    expect(captured()).toContain("Job dead-lettered after exhausting all attempts");
    expectNoSecret(captured(), "worker logs");
    expectNoSecret(await lastErrors(), "last_error");
    expect(primary.objects.size).toBe(0);
  });

  it("6. every storage entry point translates a database failure into a safe StorageError (no raw pg error escapes)", async () => {
    const dbErr = withCause(secretError("db"), secretError("provider"));
    vi.mocked(repo.transition).mockRejectedValueOnce(dbErr);
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("a") }).catch((e) => e);
    expect(stored).toBeInstanceOf(StorageError);
    expectNoSecret(dump(stored), "storeBuffer error");

    const ok = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("b") });
    vi.mocked(repo.transition).mockRejectedValueOnce(dbErr);
    const del = await storage.deleteByReference({ companyId: COMPANY, kind: "export", reference: ok.reference }).catch((e) => e);
    expect(del).toBeInstanceOf(StorageError);
    expect((del as StorageError).reason).toBe("DB_FAILURE");
    expectNoSecret(dump(del), "deleteByReference error");
    expectNoSecret(captured(), "logs");
    void randomUUID;
  });
});
