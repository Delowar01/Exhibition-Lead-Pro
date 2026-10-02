// B25 Correction 5 — AMBIGUOUS COMMIT OUTCOMES of the branding company-row
// updates. A rejected companiesRepo.update() does NOT mean the row did not
// change: the statement can commit and the connection fail before the client
// receives RETURNING. Before this correction uploadLogo then tombstoned the
// freshly stored logo although the company row already pointed at it, and
// removeLogo / resetBranding / updateBranding answered "Nothing was changed"
// for a mutation that had committed. Every injected error carries SQL text,
// parameters, a bucket path, a signed URL, a bearer token, a host path and a
// nested provider cause; the wrapper lets the REAL update commit first.
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
import * as storage from "../src/services/storage.service.js";
import { uploadLogo, removeLogo, resetBranding, updateBranding } from "../src/services/branding.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/companies.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/companies.repository.js")>();
  return { ...actual, update: vi.fn(actual.update), findById: vi.fn(actual.findById) };
});
type CompaniesRepo = typeof import("../src/repositories/companies.repository.js");
const actualRepo = await vi.importActual<CompaniesRepo>("../src/repositories/companies.repository.js");

const SECRETS = [
  "gs://secret-bucket/private-object",
  "/opt/private/storage/company-42",
  "password=hunter2-secret",
  "Bearer eyJ-secret-token",
  "https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeefsig",
  "params=[\"tenant-secret-row\"]",
  "UPDATE companies SET brand_logo_key=$1",
];
function secretDbError(): Error {
  const provider = Object.assign(new Error(`Upload to ${SECRETS[0]} failed: ${SECRETS[2]} ${SECRETS[4]}`), {
    code: 503,
    response: { body: `{"error":"${SECRETS[0]}"}` },
    config: { headers: { Authorization: SECRETS[3] }, url: SECRETS[4] },
  });
  return Object.assign(new Error(`connection terminated unexpectedly; query: ${SECRETS[6]} WHERE id=$2 ${SECRETS[5]} ${SECRETS[2]} ${SECRETS[1]}`), {
    code: "08006",
    severity: "FATAL",
    detail: SECRETS[5],
    query: SECRETS[6],
    parameters: ["tenant-secret-row", SECRETS[1]],
    cause: provider,
  });
}
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
/** The REAL update commits; the client sees a secret-bearing connection failure afterwards. */
function commitThenThrow(): CompaniesRepo["update"] {
  return async (...args) => {
    await actualRepo.update(...args);
    throw secretDbError();
  };
}
/** The REAL update commits, the client sees the failure AND the follow-up read fails too (outcome unknown). */
function commitThenThrowAndBreakRead(): CompaniesRepo["update"] {
  return async (...args) => {
    await actualRepo.update(...args);
    vi.mocked(companiesRepo.findById).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    throw secretDbError();
  };
}

const os = config.objectStorage as unknown as { driver: string; bucketId: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number };
const original = { ...os };
let COMPANY = 0;
let primary: MemoryStorageDriver;
let logged: unknown[][] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
let user: AuthUser;
const png = (seed = 10) => sharp({ create: { width: 48, height: 48, channels: 4, background: { r: seed, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
const fakeReq = () => ({ ip: "127.0.0.1", user, headers: {}, get: () => undefined }) as unknown as Request;
const captured = () => dump(logged);

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
    .select({ reference: storageObjectsTable.reference, state: storageObjectsTable.state, storageKey: storageObjectsTable.storageKey, lastError: storageObjectsTable.lastError })
    .from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.companyId, COMPANY), eq(storageObjectsTable.kind, "branding_logo")))
    .orderBy(desc(storageObjectsTable.createdAt));
}
async function lastErrors(): Promise<string> {
  const rows = await db.select({ lastError: storageObjectsTable.lastError }).from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  return rows.map((r) => r.lastError ?? "").join("\n");
}
async function audits(action: string): Promise<number> {
  const rows = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(and(eq(auditLogsTable.companyId, COMPANY), eq(auditLogsTable.action, action)));
  return rows.length;
}
function expectContainedFailure(thrown: unknown, where: string, code: string) {
  const { status, body, requestLog } = handle(thrown);
  expectNoSecret(dump(requestLog), `${where}: request error log`);
  expectNoSecret(dump(body), `${where}: API response`);
  expectNoSecret(dump(thrown), `${where}: thrown error`);
  expect(thrown, `${where}: a raw error escaped the branding service`).toBeInstanceOf(AppError);
  expect((thrown as AppError).statusCode).toBe(503);
  expect((thrown as AppError).code).toBe(code);
  expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  expect(status).toBe(503);
  expectNoSecret(captured(), `${where}: service logs`);
}

beforeAll(async () => {
  os.driver = "memory";
  os.bucketId = "fake-bucket";
  os.legacyFallback = false;
  os.mirror = false;
  os.legacyDelete = false;
  os.pendingTtlMs = 0;
  const [c] = await db.insert(companiesTable).values({ name: `B25C5 branding ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
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
  vi.mocked(companiesRepo.update).mockReset().mockImplementation(actualRepo.update);
  vi.mocked(companiesRepo.findById).mockReset().mockImplementation(actualRepo.findById);
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, COMPANY));
  await db.update(companiesTable).set({ brandLogoKey: null, brandLogoContentType: null, logoUrl: null, brandPrimaryColor: null, brandSidebarColor: null, brandDefaultTheme: null }).where(eq(companiesTable.id, COMPANY));
});

describe("A. a company-row update that COMMITTED but was not acknowledged is resolved as committed", () => {
  it("9. uploadLogo: the company points at the NEW logo, the new object stays active and readable, the old one is retired, the audit is written", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(1), "image/png");
    const oldKey = (await company()).brandLogoKey!;
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrow());
    const resolved = await uploadLogo(fakeReq(), COMPANY, await png(2), "image/png").catch((e) => e);
    const after = await company();
    expect(after.brandLogoKey).not.toBe(oldKey); // the statement had committed: the company points at the new logo
    expect(after.brandLogoKey).toMatch(/^branding\//);
    const rows = await logoRows();
    const fresh = rows.find((r) => r.reference === after.brandLogoKey)!;
    const previous = rows.find((r) => r.reference === oldKey)!;
    expect(fresh.state, "the logo the company references was tombstoned").toBe("active");
    expect(primary.objects.has(fresh.storageKey), "the logo the company references lost its bytes").toBe(true);
    expect(resolved, "a committed logo replacement was reported as a failure").not.toBeInstanceOf(Error);
    expect(resolved.logoUrl).toBeTruthy();
    expect(["deleting", "deleted"]).toContain(previous.state); // normal successful-replacement semantics
    expect(primary.objects.has(previous.storageKey)).toBe(false);
    expect(primary.deleteCalls.map((d) => d.key)).toEqual([previous.storageKey]); // the fresh object was never deleted
    const read = await storage.readObjectBuffer({ companyId: COMPANY, kind: "branding_logo", reference: after.brandLogoKey! }, 1024 * 1024);
    expect(read?.buffer.length).toBeGreaterThan(0);
    expect(await audits("branding.logo.replace")).toBe(2);
    expectNoSecret(captured(), "uploadLogo: service logs");
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("10. removeLogo: the committed cleared state is recognized, the old object is retired, no false failure", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(3), "image/png");
    const oldKey = (await company()).brandLogoKey!;
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrow());
    const resolved = await removeLogo(fakeReq(), COMPANY).catch((e) => e);
    expect((await company()).brandLogoKey).toBeNull(); // the statement had committed
    expect(resolved, "a committed logo removal was reported as 'Nothing was changed'").not.toBeInstanceOf(Error);
    expect(resolved.logoUrl).toBeNull();
    const [previous] = await logoRows();
    expect(previous.reference).toBe(oldKey);
    expect(["deleting", "deleted"]).toContain(previous.state);
    expect(await audits("branding.logo.remove")).toBe(1);
    expectNoSecret(captured(), "removeLogo: service logs");
  });

  it("11. resetBranding: the committed reset is recognized (colors cleared, logo retired)", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(4), "image/png");
    await updateBranding(fakeReq(), COMPANY, { primaryColor: "#123456", defaultTheme: "dark" });
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrow());
    const resolved = await resetBranding(fakeReq(), COMPANY).catch((e) => e);
    const after = await company();
    expect(after.brandPrimaryColor).toBeNull(); // the statement had committed
    expect(resolved, "a committed reset was reported as 'Nothing was changed'").not.toBeInstanceOf(Error);
    expect(resolved.logoUrl).toBeNull();
    expect(after.brandDefaultTheme).toBeNull();
    expect(after.brandLogoKey).toBeNull();
    expect(["deleting", "deleted"]).toContain((await logoRows())[0].state);
    expect(await audits("branding.reset")).toBe(1);
    expectNoSecret(captured(), "resetBranding: service logs");
  });

  it("12. updateBranding: committed colors / theme are recognized", async () => {
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrow());
    const resolved = await updateBranding(fakeReq(), COMPANY, { primaryColor: "#ABCDEF", sidebarColor: "#102030", defaultTheme: "light" }).catch((e) => e);
    const after = await company();
    expect(after.brandPrimaryColor?.toLowerCase()).toBe("#abcdef"); // the statement had committed
    expect(resolved, "a committed colour update was reported as 'Nothing was changed'").not.toBeInstanceOf(Error);
    expect(resolved.primaryColor.toLowerCase()).toBe("#abcdef");
    expect(after.brandSidebarColor?.toLowerCase()).toBe("#102030");
    expect(after.brandDefaultTheme).toBe("light");
    expect(await audits("branding.update")).toBe(1);
    expectNoSecret(captured(), "updateBranding: service logs");
  });
});

describe("B. an update that did NOT commit keeps the previous state", () => {
  it("13. uploadLogo / removeLogo / updateBranding rejected before commit: previous state intact, fresh upload tombstoned, fixed 503, no audit", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(5), "image/png");
    const oldKey = (await company()).brandLogoKey!;
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    const up = await uploadLogo(fakeReq(), COMPANY, await png(6), "image/png").catch((e) => e);
    expectContainedFailure(up, "uploadLogo", "BRANDING_UPDATE_FAILED");
    expect((await company()).brandLogoKey).toBe(oldKey);
    const rows = await logoRows();
    expect(rows.find((r) => r.reference === oldKey)?.state).toBe("active");
    expect(["deleting", "deleted"]).toContain(rows.find((r) => r.reference !== oldKey)!.state);

    vi.mocked(companiesRepo.update).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    const rm = await removeLogo(fakeReq(), COMPANY).catch((e) => e);
    expectContainedFailure(rm, "removeLogo", "BRANDING_UPDATE_FAILED");
    expect((await company()).brandLogoKey).toBe(oldKey);
    expect(primary.objects.has(rows.find((r) => r.reference === oldKey)!.storageKey)).toBe(true);

    vi.mocked(companiesRepo.update).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    const upd = await updateBranding(fakeReq(), COMPANY, { primaryColor: "#1E3A8A" }).catch((e) => e);
    expectContainedFailure(upd, "updateBranding", "BRANDING_UPDATE_FAILED");
    expect((await company()).brandPrimaryColor).toBeNull();
    expect(await audits("branding.logo.remove")).toBe(0);
    expect(await audits("branding.update")).toBe(0);
    expectNoSecret(await lastErrors(), "last_error");
  });
});

describe("C. an update whose outcome cannot be confirmed destroys nothing", () => {
  it("14. uploadLogo: fixed refresh-before-retry 503, neither the new nor the old object is deleted, both stay discoverable; the orphan sweep retires the unreferenced one later", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(7), "image/png");
    const oldKey = (await company()).brandLogoKey!;
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrowAndBreakRead());
    const thrown = await uploadLogo(fakeReq(), COMPANY, await png(8), "image/png").catch((e) => e);
    expect(primary.deleteCalls, "an unconfirmed outcome deleted a logo object").toEqual([]);
    const rows = await logoRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state)).toEqual(["active", "active"]);
    expect(rows.every((r) => primary.objects.has(r.storageKey))).toBe(true);
    expectContainedFailure(thrown, "uploadLogo (unknown)", "BRANDING_UPDATE_UNCONFIRMED");
    expect((thrown as AppError).message).toMatch(/could not be confirmed/i);
    expect((thrown as AppError).message).not.toMatch(/nothing was changed/i);
    expect(await audits("branding.logo.replace")).toBe(1); // no claimed success for the unconfirmed mutation
    // durable truth: the statement had committed, the company references the new logo
    const after = await company();
    expect(after.brandLogoKey).not.toBe(oldKey);
    // discoverable: the live-reference orphan pass retires exactly the unreferenced old logo after the grace window
    await storage.sweepStorage(new Date(Date.now() + 60_000));
    const settled = await logoRows();
    expect(settled.find((r) => r.reference === after.brandLogoKey)?.state).toBe("active");
    expect(["deleting", "deleted"]).toContain(settled.find((r) => r.reference === oldKey)!.state);
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("14b. removeLogo: fixed refresh-before-retry 503, the previous object is NOT deleted and stays represented in the inventory", async () => {
    await uploadLogo(fakeReq(), COMPANY, await png(9), "image/png");
    const oldKey = (await company()).brandLogoKey!;
    logged = [];
    vi.mocked(companiesRepo.update).mockImplementationOnce(commitThenThrowAndBreakRead());
    const thrown = await removeLogo(fakeReq(), COMPANY).catch((e) => e);
    expectContainedFailure(thrown, "removeLogo (unknown)", "BRANDING_UPDATE_UNCONFIRMED");
    expect(primary.deleteCalls).toEqual([]);
    const [previous] = await logoRows();
    expect(previous.reference).toBe(oldKey);
    expect(previous.state).toBe("active");
    expect(primary.objects.has(previous.storageKey)).toBe(true);
    expect(await audits("branding.logo.remove")).toBe(0);
    expectNoSecret(await lastErrors(), "last_error");
  });
});
