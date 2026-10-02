// B25 Correction 5 — AMBIGUOUS DATABASE COMMIT OUTCOMES on the storage write
// paths. A statement can commit and still reject in the client (connection lost
// before the result arrives). Before this correction:
//   • storeBuffer treated a rejected pending → active transition as "not
//     activated" and rolled the attempt back, deleting the primary and mirror
//     bytes FIRST and fencing the row second — so a committed-but-unacknowledged
//     activation left an ACTIVE row pointing at deleted bytes;
//   • rollbackServerAttempt deleted copies before proving the row could still
//     be rolled back at all;
//   • a committed-but-unacknowledged staging CAS of a client upload was reported
//     to the client as a failure although the row was staged (fail-safe, but a
//     false failure).
// Every injected error is the way node-postgres raises it (SQL text, parameters,
// bucket path, signed URL, bearer token, host path, nested provider cause) and
// is produced by a wrapper that lets the REAL repository statement commit and
// throws only after it returned — never a bare mockRejectedValue.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { eq, inArray } from "drizzle-orm";
import { db, storageObjectsTable, companiesTable } from "@workspace/db";
import { config } from "../src/config.js";
import { logger } from "../src/lib/logger.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { MemoryStorageDriver } from "../src/storage/memory-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { __resetStorageRegistryForTests, __setDriversForTests } from "../src/storage/registry.js";
import * as repo from "../src/repositories/storage-objects.repository.js";
import * as storage from "../src/services/storage.service.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

vi.mock("../src/repositories/storage-objects.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/storage-objects.repository.js")>();
  return { ...actual, transition: vi.fn(actual.transition), releaseUpload: vi.fn(actual.releaseUpload), findById: vi.fn(actual.findById) };
});
type Repo = typeof import("../src/repositories/storage-objects.repository.js");
const actualRepo = await vi.importActual<Repo>("../src/repositories/storage-objects.repository.js");

const SECRETS = [
  "gs://secret-bucket/private-object",
  "/opt/private/storage/company-42",
  "password=hunter2-secret",
  "Bearer eyJ-secret-token",
  "https://storage.googleapis.com/secret-bucket/o?X-Goog-Signature=deadbeefsig",
  "params=[\"tenant-secret-row\"]",
  "UPDATE storage_objects SET state=$1",
];
/** A pg-style driver error (SQL, parameters, host path) carrying a provider error (bucket, signed URL, bearer) as its cause. */
function secretDbError(): Error {
  const provider = Object.assign(new Error(`Upload to ${SECRETS[0]} failed: ${SECRETS[2]} ${SECRETS[4]}`), {
    code: 503,
    response: { body: `{"error":"${SECRETS[0]}"}` },
    config: { headers: { Authorization: SECRETS[3] }, url: SECRETS[4] },
  });
  return Object.assign(new Error(`connection terminated unexpectedly; query: ${SECRETS[6]} WHERE id=$2 ${SECRETS[5]} ${SECRETS[1]}`), {
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

type MutableStorageConfig = { driver: string; bucketId: string; privateObjectDir: string; legacyFallback: boolean; mirror: boolean; legacyDelete: boolean; pendingTtlMs: number };
const os = config.objectStorage as unknown as MutableStorageConfig;
const original = { ...os };

const companies: number[] = [];
let COMPANY = 0;
let store: FakeBucketStore;
let gcsDriver: GcsStorageDriver;
let memoryPrimary: MemoryStorageDriver;
let user: AuthUser;
/** Ordered timeline of database fences and provider deletes (the ordering proofs). */
let events: string[] = [];
let logged: unknown[][] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
const captured = () => dump(logged);
const objectName = (key: string) => key.replace(/^gs:\/\/fake-bucket\//, "");

function useMemoryOnly() {
  os.driver = "memory";
  os.mirror = false;
  __setDriversForTests({ primary: memoryPrimary, legacy: gcsDriver });
}
function useGcsPrimary() {
  os.driver = "gcs";
  os.mirror = false;
  __setDriversForTests({ primary: gcsDriver, legacy: gcsDriver });
}
function useMemoryPrimaryWithGcsMirror() {
  os.driver = "memory";
  os.mirror = true;
  __setDriversForTests({ primary: memoryPrimary, legacy: gcsDriver });
}
/** Default mock behaviour: the real statement, with every fence recorded on the timeline. */
function recordingTransition(): Repo["transition"] {
  return async (id, from, to, data, tx) => {
    const row = await actualRepo.transition(id, from, to, data, tx);
    events.push(`transition:${from.join("|")}->${to}:${row ? "hit" : "miss"}`);
    return row;
  };
}
/** The REAL statement commits; the client sees a secret-bearing connection failure afterwards. */
function commitThenThrow<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
  return (async (...args: Parameters<F>) => {
    await (fn as (...a: Parameters<F>) => Promise<unknown>)(...args);
    throw secretDbError();
  }) as F;
}
async function newCompany(label: string): Promise<number> {
  const [c] = await db.insert(companiesTable).values({ name: `B25C5 ${label} ${Date.now()}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companies.push(c.id);
  return c.id;
}
async function row(id: string) {
  return (await actualRepo.findById(id))!;
}
function deletesOf(driver: MemoryStorageDriver | GcsStorageDriver) {
  return events.filter((e) => e.startsWith(`delete:${driver.kind}:`));
}
function expectFenceBeforeEveryDelete() {
  const firstFence = events.findIndex((e) => e.startsWith("transition:") && (e.includes("->failed") || e.includes("->deleting")));
  const deletes = events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith("delete:"));
  expect(deletes.length).toBeGreaterThan(0);
  expect(firstFence, `no fence recorded before the deletes: ${events.join(", ")}`).toBeGreaterThanOrEqual(0);
  for (const [e, i] of deletes) expect(i, `${e} happened before the row was fenced: ${events.join(", ")}`).toBeGreaterThan(firstFence);
}

beforeAll(async () => {
  os.bucketId = "fake-bucket";
  os.privateObjectDir = "/fake-bucket/.private";
  os.legacyFallback = false;
  os.legacyDelete = true;
  os.pendingTtlMs = 0;
  COMPANY = await newCompany("activation");
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
  if (companies.length) {
    await db.delete(storageObjectsTable).where(inArray(storageObjectsTable.companyId, companies));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companies));
  }
});
beforeEach(async () => {
  __resetStorageRegistryForTests();
  store = new FakeBucketStore();
  gcsDriver = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
  memoryPrimary = new MemoryStorageDriver();
  for (const d of [memoryPrimary, gcsDriver] as const) {
    const original = d.delete.bind(d);
    vi.spyOn(d, "delete").mockImplementation(async (key, opts) => {
      events.push(`delete:${d.kind}:${key}:${opts?.ifGeneration ?? "UNCONDITIONAL"}`);
      return original(key, opts);
    });
  }
  events = [];
  logged = [];
  vi.mocked(repo.transition).mockReset().mockImplementation(recordingTransition());
  vi.mocked(repo.releaseUpload).mockReset().mockImplementation(actualRepo.releaseUpload);
  vi.mocked(repo.findById).mockReset().mockImplementation(actualRepo.findById);
  await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  useMemoryOnly();
});
async function lastErrors(): Promise<string> {
  const rows = await db.select({ lastError: storageObjectsTable.lastError }).from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
  return rows.map((r) => r.lastError ?? "").join("\n");
}

describe("A. a server-side activation that COMMITTED but was not acknowledged is resolved as success", () => {
  it("1. memory primary: the active row keeps its bytes, no delete is issued, the write resolves normally", async () => {
    vi.mocked(repo.transition).mockImplementationOnce(commitThenThrow(recordingTransition()));
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("report bytes") }).catch((e) => e);
    const [active] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(active.state).toBe("active"); // the statement had committed
    expect(memoryPrimary.objects.has(active.storageKey), "the ACTIVE row's bytes were deleted").toBe(true);
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual([]);
    expect(stored, "a committed activation was reported as a failure").not.toBeInstanceOf(Error);
    expect(active.sha256).toBe(stored.sha256);
    const read = await storage.readObjectBuffer({ companyId: COMPANY, kind: "report", reference: stored.reference }, 1024);
    expect(read?.buffer.toString()).toBe("report bytes");
    expectNoSecret(captured(), "service logs");
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("2. fake GCS primary: the committed generation remains, no generation delete occurred, uncertainty is cleared by the committed activation", async () => {
    useGcsPrimary();
    vi.mocked(repo.transition).mockImplementationOnce(commitThenThrow(recordingTransition()));
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "export", contentType: "text/csv", buffer: Buffer.from("a,b,c") }).catch((e) => e);
    const [active] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(active.state).toBe("active");
    expect(active.publicationUncertainAt).toBeNull();
    const name = objectName(active.storageKey);
    expect(store.objects.get(name)?.generation, "the ACTIVE row's committed generation was deleted").toBe("1");
    expect(store.deleteCalls).toEqual([]);
    expect(deletesOf(gcsDriver)).toEqual([]);
    expect(stored, "a committed activation was reported as a failure").not.toBeInstanceOf(Error);
    expect(stored.objectId).toBe(active.id);
    expectNoSecret(captured(), "service logs");
  });

  it("3. strict mirror: both committed copies remain, mirror_state is ok, no delete on either provider", async () => {
    useMemoryPrimaryWithGcsMirror();
    vi.mocked(repo.transition).mockImplementationOnce(commitThenThrow(recordingTransition()));
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("mirrored") }).catch((e) => e);
    const [active] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(active.state).toBe("active");
    expect(active.mirrorState).toBe("ok");
    expect(active.publicationUncertainAt).toBeNull();
    expect(memoryPrimary.objects.has(active.storageKey), "the ACTIVE row's primary copy was deleted").toBe(true);
    expect(store.objects.has(objectName(active.mirrorKey!)), "the ACTIVE row's mirror copy was deleted").toBe(true);
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual([]);
    expect(store.deleteCalls).toEqual([]);
    expect(stored, "a committed activation was reported as a failure").not.toBeInstanceOf(Error);
  });
});

describe("B. an activation that did NOT commit is fenced before anything is deleted", () => {
  it("4. pre-commit failure: the pending → failed fence precedes every delete; only this attempt's copies go (mirror by generation)", async () => {
    useMemoryPrimaryWithGcsMirror();
    vi.mocked(repo.transition).mockImplementationOnce(async () => {
      events.push("transition:pending->active:rejected-before-commit");
      throw secretDbError();
    });
    const thrown = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("never activated") }).catch((e) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    expectNoSecret(dump(thrown), "thrown error");
    const [failed] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(failed.state).toBe("failed");
    expectFenceBeforeEveryDelete();
    expect(memoryPrimary.objects.has(failed.storageKey)).toBe(false);
    expect(store.objects.has(objectName(failed.mirrorKey!))).toBe(false);
    expect(store.deleteCalls.every((c) => c.opts?.ifGenerationMatch !== undefined)).toBe(true);
    expect(events.some((e) => e.endsWith(":UNCONDITIONAL") && e.startsWith("delete:gcs"))).toBe(false);
    expectNoSecret(captured(), "service logs");
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("5. outcome UNKNOWN (transition rejected after commit AND the re-read fails): nothing is deleted, the fixed error carries no secret, row and bytes stay discoverable", async () => {
    useMemoryPrimaryWithGcsMirror();
    vi.mocked(repo.transition).mockImplementationOnce(commitThenThrow(recordingTransition()));
    vi.mocked(repo.findById).mockImplementation(async () => {
      throw secretDbError();
    });
    const thrown = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("unknown outcome") }).catch((e) => e);
    vi.mocked(repo.findById).mockImplementation(actualRepo.findById);
    const [committed] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(committed.state).toBe("active"); // the statement had committed: the row stays active WITH its bytes
    expect(events.filter((e) => e.startsWith("delete:")), "an unknown outcome must never delete").toEqual([]);
    expect(store.deleteCalls).toEqual([]);
    expect(memoryPrimary.objects.has(committed.storageKey)).toBe(true);
    expect(store.objects.has(objectName(committed.mirrorKey!))).toBe(true);
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).code).toBe("STORAGE_UNAVAILABLE");
    expect((thrown as StorageError).reason).toBe("OUTCOME_UNKNOWN");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expectNoSecret(dump(thrown), "thrown error");
    expectNoSecret(captured(), "service logs");
    expectNoSecret(await lastErrors(), "last_error");
  });

  it("5b. outcome UNKNOWN with the row still pending: nothing is deleted; the pending row and its copies remain for the sweep", async () => {
    useMemoryPrimaryWithGcsMirror();
    vi.mocked(repo.transition).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    vi.mocked(repo.findById).mockImplementation(async () => {
      throw secretDbError();
    });
    const thrown = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("pending unknown") }).catch((e) => e);
    vi.mocked(repo.findById).mockImplementation(actualRepo.findById);
    expect(thrown).toBeInstanceOf(StorageError);
    expectNoSecret(dump(thrown), "thrown error");
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual([]);
    const [pending] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(memoryPrimary.objects.has(pending.storageKey)).toBe(true);
    expect(store.objects.has(objectName(pending.mirrorKey!))).toBe(true);
    // the sweep settles it from the persisted locations later (pending TTL 0 here), with the generation precondition
    await storage.sweepStorage(new Date(Date.now() + 60_000));
    expect(memoryPrimary.objects.has(pending.storageKey)).toBe(false);
    expect(store.objects.has(objectName(pending.mirrorKey!))).toBe(false);
    expect(store.deleteCalls.every((c) => c.opts?.ifGenerationMatch !== undefined)).toBe(true);
  });

  it("6. fence CAS lost to ACTIVE (the first statement's effect lands late): no delete, the write resolves as committed", async () => {
    useMemoryPrimaryWithGcsMirror();
    let activation: Parameters<Repo["transition"]> | undefined;
    vi.mocked(repo.transition)
      .mockImplementationOnce(async (...args) => {
        activation = args;
        events.push("transition:pending->active:rejected-before-commit");
        throw secretDbError();
      })
      .mockImplementationOnce(async (...args) => {
        await actualRepo.transition(...activation!); // the delayed effect of the rejected statement arrives first
        return recordingTransition()(...args); // … so the fence (pending → failed) misses
      });
    const stored = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("late activation") });
    const active = await row(stored.objectId);
    expect(active.state).toBe("active");
    expect(events).toContain("transition:pending->failed:miss");
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual([]);
    expect(memoryPrimary.objects.has(active.storageKey)).toBe(true);
    expect(store.objects.has(objectName(active.mirrorKey!))).toBe(true);
  });

  it("7. fence CAS lost to a TOMBSTONE (company deletion fenced the row): only this attempt's copies are cleaned, by generation, after the fence attempt", async () => {
    useMemoryPrimaryWithGcsMirror();
    const foreign = store.seed("tenants/unrelated/object", Buffer.from("someone else's object"));
    vi.mocked(repo.transition)
      .mockImplementationOnce(async () => {
        events.push("transition:pending->active:rejected-before-commit");
        throw secretDbError();
      })
      .mockImplementationOnce(async (id, from, to, data, tx) => {
        await actualRepo.transition(id, ["pending"], "deleting", { deletedAt: new Date() }); // company deletion got there first
        return recordingTransition()(id, from, to, data, tx);
      });
    const thrown = await storage.storeBuffer({ companyId: COMPANY, kind: "report", contentType: "application/pdf", buffer: Buffer.from("fenced out") }).catch((e) => e);
    expect(thrown).toBeInstanceOf(StorageError);
    const [tomb] = await db.select().from(storageObjectsTable).where(eq(storageObjectsTable.companyId, COMPANY));
    expect(tomb.state).toBe("deleting");
    expect(events).toContain("transition:pending->failed:miss");
    expectFenceBeforeEveryDelete();
    expect(memoryPrimary.objects.has(tomb.storageKey)).toBe(false);
    expect(store.objects.has(objectName(tomb.mirrorKey!))).toBe(false);
    expect(store.deleteCalls.map((c) => c.name)).toEqual([objectName(tomb.mirrorKey!)]); // only the attempt's own mirror copy
    expect(store.deleteCalls.every((c) => c.opts?.ifGenerationMatch !== undefined)).toBe(true);
    expect(store.objects.get("tenants/unrelated/object")?.generation).toBe(foreign.generation);
  });
});

describe("C. a client upload whose staging CAS committed but was not acknowledged", () => {
  it("8. GCS primary: the staged row keeps its bytes, uncertainty is cleared by the committed CAS, no rollback delete, the upload resolves", async () => {
    useGcsPrimary();
    const r = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 4096 });
    vi.mocked(repo.releaseUpload).mockImplementationOnce(commitThenThrow(actualRepo.releaseUpload));
    const bytes = randomBytes(256);
    const ok = await storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([bytes])).catch((e) => e);
    const staged = await row(r.objectId);
    expect(staged.state).toBe("staged"); // the CAS had committed
    expect(staged.leaseToken).toBeNull();
    expect(staged.publicationUncertainAt).toBeNull();
    expect(store.objects.has(objectName(staged.storageKey))).toBe(true);
    expect(store.deleteCalls).toEqual([]);
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual([]);
    expect(ok, "a committed staging was reported to the client as a failure").not.toBeInstanceOf(Error);
    expect(ok.sizeBytes).toBe(256);
    expectNoSecret(captured(), "service logs");
  });

  it("8b. staging rejected BEFORE commit: the fenced rollback (lease CAS first) removes only this attempt's copy", async () => {
    useGcsPrimary();
    const r = await storage.reserveUpload(null, { companyId: COMPANY, userId: user.id, kind: "document", contentType: "text/plain", declaredSize: 4096 });
    vi.mocked(repo.releaseUpload).mockImplementationOnce(async () => {
      throw secretDbError();
    });
    const thrown = await storage.receiveUpload(user, r.objectId, r.uploadToken, Readable.from([randomBytes(100)])).catch((e) => e);
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(503);
    expectNoSecret(dump(thrown), "thrown error");
    const failed = await row(r.objectId);
    expect(failed.state).toBe("failed");
    expect(store.objects.has(objectName(failed.storageKey))).toBe(false);
    expect(store.deleteCalls.every((c) => c.opts?.ifGenerationMatch !== undefined)).toBe(true);
    expectNoSecret(captured(), "service logs");
    expectNoSecret(await lastErrors(), "last_error");
  });
});
