// B25 Correction 9 — HTTP-ROUTE proof (opt-in): GET/HEAD /api/files/:id through a REAL API instance whose
// gcs driver talks to the loopback stand-in (helpers/gcs-emulator.mjs). Separate from the driver-level proof
// (b25c9-gcs-stream-cancel.test.ts): here routes/files.ts, storage.service (locateCopies / verifiedStream)
// and the driver run together in one process that must survive every scenario. The API is spawned by this
// test on a free port with the gcs driver pointed at the stand-in (no credentials, no network beyond
// 127.0.0.1) against the LOCAL database named by DATABASE_URL; nothing is deployed and the normal suite
// (fs driver, live API on :80) is untouched. Enable with B25C9_HTTP_PROOF=1 (DATABASE_URL + SESSION_SECRET
// exported); the API binary is process.execPath, so running vitest under node 24 proves node 24.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, companiesTable, subscriptionsTable, usersTable, sessionsTable, storageObjectsTable, documentsTable, documentVersionsTable, auditLogsTable, loginAttemptsTable } from "@workspace/db";
import { hashPassword } from "../src/lib/auth.js";

const enabled = process.env.B25C9_HTTP_PROOF === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const helpers = path.join(here, "helpers");
const pkg = path.join(here, "..");
const SUFFIX = Date.now();
const DOMAIN = `b25c9http-${SUFFIX}.invalid`;
const EMAIL = `admin@${DOMAIN}`;
const PW = "B25c9-Proof-Password!";

let emulator: ChildProcess | null = null;
let api: ChildProcess | null = null;
let emuPort = 0;
let apiPort = 0;
let sha = "";
let apiLog = "";
let companyId = 0;
let token = "";
const objectIds: string[] = [];
const BYTES = 200 * 1024;

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const p = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}
type Resp = { status: number; headers: http.IncomingHttpHeaders; bytes: number; sha: string; ended: boolean; error: string | null };
/** Raw HTTP client (no keep-alive); `abortAfterBytes` destroys the socket mid-body like a client that went away. */
function request(method: string, p: string, opts: { abortAfterBytes?: number; timeoutMs?: number } = {}): Promise<Resp> {
  return new Promise((resolve) => {
    const h = createHash("sha256");
    let bytes = 0;
    let ended = false;
    let error: string | null = null;
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    const req = http.request({ host: "127.0.0.1", port: apiPort, method, path: p, agent: false, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      status = res.statusCode ?? 0;
      headers = res.headers;
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        h.update(c);
        if (opts.abortAfterBytes !== undefined && bytes >= opts.abortAfterBytes) req.destroy();
      });
      res.on("end", () => { ended = true; });
      res.on("close", () => resolve({ status, headers, bytes, sha: h.digest("hex"), ended, error }));
      res.on("error", (e) => { error = String((e as any).code || e.message); });
    });
    req.on("error", (e) => { error = error ?? String((e as any).code || e.message); resolve({ status, headers, bytes, sha: "", ended, error }); });
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => { error = "CLIENT_TIMEOUT"; req.destroy(); });
    req.end();
  });
}
async function healthz(): Promise<number> {
  return (await request("GET", "/api/healthz")).status;
}
function stats(): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${emuPort}/__emu/stats`, { agent: false }, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b))); }).on("error", reject);
  });
}
async function seedObject(behaviour: string, opts: { sizeBytes?: number | null; sha256?: string | null } = {}) {
  const id = crypto.randomUUID();
  const storageKey = `tenants/${companyId}/documents/${id}-${behaviour}-row`;
  await db.insert(storageObjectsTable).values({
    id, companyId, kind: "document", reference: `/objects/${id}`, storageKey, driver: "gcs", legacyKey: `gs://fake-bucket/${storageKey}`,
    contentType: "application/pdf", sizeBytes: opts.sizeBytes === undefined ? BYTES : opts.sizeBytes, sha256: opts.sha256 === undefined ? sha : opts.sha256, state: "active",
  } as never);
  const [doc] = await db.insert(documentsTable).values({ companyId, entityType: "lead", entityId: 1, name: `b25c9 ${behaviour}`, category: "other" } as never).returning({ id: documentsTable.id });
  await db.insert(documentVersionsTable).values({ companyId, documentId: doc.id, versionNumber: 1, objectPath: `/objects/${id}`, fileName: "f.pdf", fileSize: BYTES, mimeType: "application/pdf" } as never);
  objectIds.push(id);
  return id;
}

beforeAll(async () => {
  if (!enabled) return;
  emuPort = await freePort();
  apiPort = await freePort();
  emulator = spawn(process.execPath, [path.join(helpers, "gcs-emulator.mjs")], { env: { ...process.env, EMU_PORT: String(emuPort), EMU_ROW_ID: "row" }, stdio: ["ignore", "pipe", "pipe"] });
  sha = await new Promise<string>((resolve, reject) => {
    emulator!.stdout!.once("data", (d) => resolve(String(d).trim()));
    emulator!.once("exit", (c) => reject(new Error(`stand-in exited ${c}`)));
  });
  const [c] = await db.insert(companiesTable).values({ name: `B25C9 HTTP ${SUFFIX}`, plan: "professional", status: "active" } as never).returning({ id: companiesTable.id });
  companyId = c.id;
  await db.insert(subscriptionsTable).values({ companyId, plan: "professional", status: "active", billingSource: "manual" } as never);
  await db.insert(usersTable).values({ email: EMAIL, passwordHash: hashPassword(PW), name: "B25C9 Proof", role: "primary_admin", companyId, isActive: true } as never);
  api = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: pkg,
    env: { ...process.env, NODE_ENV: "test", PORT: String(apiPort), OBJECT_STORAGE_DRIVER: "gcs", DEFAULT_OBJECT_STORAGE_BUCKET_ID: "fake-bucket", PRIVATE_OBJECT_DIR: "/fake-bucket/.private", OBJECT_STORAGE_AUTH: "google", STORAGE_EMULATOR_HOST: `http://127.0.0.1:${emuPort}`, LOG_LEVEL: "warn", OBJECT_STORAGE_LEGACY_FALLBACK: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  api.stdout!.on("data", (d) => (apiLog += d));
  api.stderr!.on("data", (d) => (apiLog += d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited early (${api.exitCode})\n${apiLog.slice(-2000)}`);
    try { if ((await request("GET", "/api/healthz")).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const login = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ email: EMAIL, password: PW });
    const req = http.request({ host: "127.0.0.1", port: apiPort, method: "POST", path: "/api/auth/login", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
    req.on("error", reject);
    req.end(body);
  });
  if (login.status !== 200) throw new Error(`login failed ${login.status} ${login.body.slice(0, 200)}`);
  token = JSON.parse(login.body).token;
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  api?.kill("SIGTERM");
  emulator?.kill();
  if (api) await Promise.race([once(api, "close"), new Promise((r) => setTimeout(r, 5000))]);
  if (companyId) {
    await db.delete(documentVersionsTable).where(eq(documentVersionsTable.companyId, companyId));
    await db.delete(documentsTable).where(eq(documentsTable.companyId, companyId));
    await db.delete(storageObjectsTable).where(eq(storageObjectsTable.companyId, companyId));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyId));
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.companyId, companyId));
    for (const u of users) await db.delete(sessionsTable).where(eq(sessionsTable.userId, u.id));
    await db.delete(loginAttemptsTable).where(eq(loginAttemptsTable.email, EMAIL));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
});

const run = enabled ? describe : describe.skip;
run(`B25 C9 — HTTP route proof: GET/HEAD /api/files/:id through a real API wired to the stand-in (node ${process.versions.node})`, () => {
  const alive = async () => {
    expect(api!.exitCode, `API process exited\n${apiLog.slice(-3000)}`).toBeNull();
    expect(await healthz()).toBe(200);
    expect(apiLog).not.toContain("ERR_STREAM_UNABLE_TO_PIPE");
  };

  it("HEAD (the route closes the object stream before the provider answers) returns 200 with the headers and the API stays alive", async () => {
    const id = await seedObject("late-slowbody");
    const r = await request("HEAD", `/api/files/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe(String(BYTES));
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.bytes).toBe(0);
    await new Promise((res) => setTimeout(res, 1500));
    const st = await stats();
    const key = `tenants/${companyId}/documents/${id}-late-slowbody-row`;
    expect(st.media[key]).toEqual([200]);  // the delayed response still arrived and was torn down
    expect(st.aborted[key]).toBe(1);
    await alive();
  }, 30_000);

  it("ten HEADs in a row (five concurrent) keep the API alive", async () => {
    const id = await seedObject("late-slowbody");
    const rs = await Promise.all(Array.from({ length: 5 }, () => request("HEAD", `/api/files/${id}`)));
    for (const r of rs) expect(r.status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await request("HEAD", `/api/files/${id}`)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1500));
    await alive();
  }, 30_000);

  it("GET delivers the exact bytes (Content-Length, sha256) with no-referrer / no-store headers", async () => {
    const id = await seedObject("plain");
    const r = await request("GET", `/api/files/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe(String(BYTES));
    expect(r.headers["cache-control"]).toBe("private, no-store, no-transform");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.bytes).toBe(BYTES);
    expect(r.sha).toBe(sha);
    expect(r.ended).toBe(true);
    await alive();
  }, 30_000);

  it("a client that disconnects mid-body tears the provider transfer down; the API stays alive", async () => {
    const id = await seedObject("slowbody");
    const r = await request("GET", `/api/files/${id}`, { abortAfterBytes: 8192 });
    expect(r.status).toBe(200);
    expect(r.bytes).toBeLessThan(BYTES);
    await new Promise((res) => setTimeout(res, 1000));
    const st = await stats();
    expect(st.aborted[`tenants/${companyId}/documents/${id}-slowbody-row`]).toBe(1);
    await alive();
  }, 30_000);

  it("provider drops the connection mid-body: NO byte reaches the client (the first chunk stays buffered inside the API) until the client's own bound; the API stays alive (pre-existing: the stall is the SDK's, the buffering is the route/middleware's — neither changed by the driver fix)", async () => {
    const id = await seedObject("midfail");
    const r = await request("GET", `/api/files/${id}`, { timeoutMs: 3000 });
    expect(r.error).toBe("CLIENT_TIMEOUT");
    expect(r.status).toBe(0);
    expect(r.bytes).toBe(0);
    await alive();
  }, 30_000);

  it("provider error before the response (500 on every attempt): the driver re-opens twice, then the response socket is reset before any status is written (pre-existing: node's pipeline() destroys the response on a source error before the route can answer 503); the API stays alive", async () => {
    const id = await seedObject("err500");
    const r = await request("GET", `/api/files/${id}`);
    expect(r.error).toBe("ECONNRESET");
    expect(r.status).toBe(0);
    const st = await stats();
    expect(st.media[`tenants/${companyId}/documents/${id}-err500-row`]).toEqual([500, 500, 500]);
    await alive();
  }, 30_000);

  it("a transient provider error (first attempt 500) is re-opened by the driver and the exact bytes are served", async () => {
    const id = await seedObject("flaky");
    const r = await request("GET", `/api/files/${id}`);
    expect(r.status).toBe(200);
    expect(r.sha).toBe(sha);
    const st = await stats();
    expect(st.media[`tenants/${companyId}/documents/${id}-flaky-row`]).toEqual([500, 200]);
    await alive();
  }, 30_000);

  it("an integrity mismatch (bytes differ from the inventory digest) is a truncated transfer, never a silently wrong file; the API stays alive", async () => {
    const id = await seedObject("badsha");
    const r = await request("GET", `/api/files/${id}`);
    expect(r.status).toBe(200);
    expect(r.ended).toBe(false); // the response is destroyed mid-stream
    expect(r.sha).not.toBe(sha);
    await alive();
  }, 30_000);

  it("an object whose provider copy is gone after a successful head (media 404): the response socket is reset before any status is written (same pre-existing route behaviour); the API stays alive", async () => {
    const id = await seedObject("media404");
    const r = await request("GET", `/api/files/${id}`);
    expect(r.error).toBe("ECONNRESET");
    expect(r.status).toBe(0);
    await alive();
  }, 30_000);

  it("the API log carries no uncaught stream error and the process is the one that was started", async () => {
    await alive();
    // "Unhandled request error" is the API's ordinary log line for an AppError; the signals of a crash are the
    // stream error code and node's uncaught-exception banner
    expect(apiLog).not.toContain("ERR_STREAM_UNABLE_TO_PIPE");
    expect(apiLog).not.toMatch(/uncaughtException|triggerUncaughtException/);
  });
});
