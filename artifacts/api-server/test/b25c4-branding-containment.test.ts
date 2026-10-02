// B25 Correction 4 — the LAST raw-error escape on a storage path: the branding
// service's company-row updates. After the new logo object is stored, a
// failing `companiesRepo.update()` used to tombstone the new object and then
// rethrow the RAW database error; the global request handler logs non-storage
// errors with the generic `{ err }` serializer (pino: message, stack, cause
// chain, enumerable properties), so SQL text, parameters, paths and tokens
// carried by the driver error reached the log. The same unguarded update exists
// in removeLogo() and resetBranding().
//
// Red on f000f20: uploadLogo rethrows the raw error (no AppError, no stable
// code) and the handler's request log contains every injected secret.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Request, Response } from "express";
import { db, storageObjectsTable, companiesTable, auditLogsTable } from "@workspace/db";
import { config } from "../src/config.js";
import { logger } from "../src/lib/logger.js";
import { AppError, errorHandler } from "../src/middlewares/errorHandler.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as companiesRepo from "../src/repositories/companies.repository.js";
import { uploadLogo, removeLogo, resetBranding } from "../src/services/branding.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/companies.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/companies.repository.js")>();
  return { ...actual, update: vi.fn(actual.update) };
});

const SECRETS = [
  "gs://secret-bucket/private-object",
  "/opt/private/storage/company-42",
  "password=hunter2-secret",
  "Bearer eyJ-secret-token",
  "https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeefsig",
  "params=[\"tenant-secret-row\"]",
  "UPDATE companies SET brand_logo_key=$1",
];
/** A pg-style driver error the way node-postgres raises it, carrying a provider error as its cause. */
function secretDbError(): Error {
  const provider = Object.assign(new Error(`Upload to ${SECRETS[0]} failed: ${SECRETS[2]} ${SECRETS[4]}`), {
    code: 503,
    response: { body: `{"error":"${SECRETS[0]}"}` },
    config: { headers: { Authorization: SECRETS[3] }, url: SECRETS[4] },
  });
  return Object.assign(new Error(`connection terminated; query: ${SECRETS[6]} WHERE id=$2 ${SECRETS[5]} ${SECRETS[2]} ${SECRETS[1]}`), {
    code: "57P01",
    severity: "FATAL",
    detail: SECRETS[5],
    query: SECRETS[6],
    parameters: ["tenant-secret-row", SECRETS[1]],
    cause: provider,
  });
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
let logged: unknown[][] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
let user: AuthUser;
const png = () => sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
const fakeReq = () => ({ ip: "127.0.0.1", user, headers: {}, get: () => undefined }) as unknown as Request;
const captured = () => dump(logged);

/** Run the global handler exactly as Express would for a thrown route error. */
function handle(thrown: unknown): { status: number; body: unknown; requestLog: unknown[][] } {
  const requestLog: unknown[][] = [];
  const req = { id: "req-1", log: { error: (...args: unknown[]) => requestLog.push(args) }, body: { note: "request body must not be echoed either" } } as unknown as Request;
  let body: unknown;
  let status = 0;
  const res = { headersSent: false, setHeader: () => undefined, status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response;
  errorHandler(thrown, req, res, () => undefined);
  return { status, body, requestLog };
}

async function company() {
  const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, COMPANY)).limit(1);
  return row;
}
async function logoRows() {
  return db
    .select({ reference: storageObjectsTable.reference, state: storageObjectsTable.state, lastError: storageObjectsTable.lastError })
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.companyId, COMPANY), eq(storageObjectsTable.kind, "branding_logo")))
    .orderBy(desc(storageObjectsTable.createdAt));
}
async function lastErrors(): Promise<string> {
  const rows = await db.select({ lastError: storageObjectsTable.lastError }).from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  return rows.map((r) => r.lastError ?? "").join("\n");
}
function expectContained(thrown: unknown, where: string) {
  // the defect itself first: the global handler's request log (generic `{ err }` serializer)
  const { status, body, requestLog } = handle(thrown);
  expectNoSecret(dump(requestLog), `${where}: request error log`);
  expectNoSecret(dump(body), `${where}: API response`);
  expectNoSecret(dump(thrown), `${where}: thrown error`);
  // then the contract: a fixed client-safe error with a stable code and no cause
  expect(thrown, `${where}: a raw error escaped the branding service`).toBeInstanceOf(AppError);
  expect((thrown as AppError).statusCode).toBe(503);
  expect((thrown as AppError).code).toBe("BRANDING_UPDATE_FAILED");
  expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  expect(status).toBe(503);
  expect(dump(body)).toContain("BRANDING_UPDATE_FAILED");
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.legacyFallback = false;
  os.mirror = false;
  os.legacyDelete = false;
  const [c] = await db.insert(companiesTable).values({ name: `B25C4 branding ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
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
  __setDriversForTests({ primary, legacy: null });
  logged = [];
  vi.mocked(companiesRepo.update).mockReset();
  vi.mocked(companiesRepo.update).mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("../src/repositories/companies.repository.js")>("../src/repositories/companies.repository.js");
    return actual.update(...args);
  });
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  await db.update(companiesTable).set({ brandLogoKey: null, brandLogoContentType: null, logoUrl: null, brandPrimaryColor: null }).where(eq(companiesTable.id, COMPANY));
});

describe("12. branding company-row update failures never reach the generic logger raw", () => {
  it("uploadLogo: a failing row update tombstones the NEW object, keeps the previous logo current and throws a fixed client-safe error", async () => {
    const first = await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    expect(first.logoUrl).toBeTruthy();
    const firstKey = (await company()).brandLogoKey;
    expect(firstKey).toBeTruthy();
    expect(primary.objects.size).toBe(1);

    vi.mocked(companiesRepo.update).mockRejectedValueOnce(secretDbError());
    let thrown: unknown;
    try {
      await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    } catch (e) {
      thrown = e;
    }
    expectContained(thrown, "uploadLogo");
    expectNoSecret(captured(), "uploadLogo: service logs");
    expect(captured()).toMatch(/Branding: company row update (statement rejected|did not commit)/);

    // the row never changed: previous logo still current, new object tombstoned and physically removed
    expect((await company()).brandLogoKey).toBe(firstKey);
    const rows = await logoRows();
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.reference !== firstKey)!;
    expect(fresh).toBeDefined();
    expect(["deleting", "deleted"]).toContain(fresh.state);
    expect(rows.find((r) => r.reference === firstKey)?.state).toBe("active");
    expect(primary.objects.size).toBe(1);
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("removeLogo: a failing row update leaves the logo in place, logs sanitized and throws the fixed error", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    const key = (await company()).brandLogoKey;
    expect(key).toBeTruthy();
    logged = [];
    vi.mocked(companiesRepo.update).mockRejectedValueOnce(secretDbError());
    let thrown: unknown;
    try {
      await removeLogo(fakeReq(), COMPANY);
    } catch (e) {
      thrown = e;
    }
    expectContained(thrown, "removeLogo");
    expectNoSecret(captured(), "removeLogo: service logs");
    expect(captured()).toMatch(/Branding: company row update (statement rejected|did not commit)/);
    expect((await company()).brandLogoKey).toBe(key);
    expect((await logoRows()).map((r) => r.state)).toEqual(["active"]);
    expect(primary.objects.size).toBe(1);
  });

  it("resetBranding: a failing row update leaves colors and logo in place, logs sanitized and throws the fixed error", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(), "image/png");
    await db.update(companiesTable).set({ brandPrimaryColor: "#123456" }).where(eq(companiesTable.id, COMPANY));
    const key = (await company()).brandLogoKey;
    logged = [];
    vi.mocked(companiesRepo.update).mockRejectedValueOnce(secretDbError());
    let thrown: unknown;
    try {
      await resetBranding(fakeReq(), COMPANY);
    } catch (e) {
      thrown = e;
    }
    expectContained(thrown, "resetBranding");
    expectNoSecret(captured(), "resetBranding: service logs");
    expect(captured()).toMatch(/Branding: company row update (statement rejected|did not commit)/);
    const after = await company();
    expect(after.brandLogoKey).toBe(key);
    expect(after.brandPrimaryColor).toBe("#123456");
    expect((await logoRows()).map((r) => r.state)).toEqual(["active"]);
    expect(primary.objects.size).toBe(1);
    expectNoSecret(await lastErrors(), "last_error");
  });
});
