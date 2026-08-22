// Batch 9 — Reports & Export Center: focused coverage of the existing
// reports / exports / schedules APIs the workspace UI now consumes.
//
// Storage note: export files are uploaded to object storage. When GCS is not
// configured (typical localhost), generation deterministically fails AFTER
// recording a failed export_runs row (502 "Export storage upload failed").
// Tests that require completed files run only when storage is reachable
// (probed via /readyz); the degraded path is asserted explicitly otherwise —
// nothing is silently hidden either way.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, usersTable, loginAttemptsTable, exportRunsTable, exportSchedulesTable } from "@workspace/db";
import { eq, like, inArray } from "drizzle-orm";

const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const EMP_EMAIL = "b9-permless-employee@techcorp.com";
const EMP_PASSWORD = "Emp9!Secret";

async function login(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// Probe object storage once — decides which export branch runs below.
const readyz = await fetch(`${BASE}/readyz`).then((r) => r.json());
const STORAGE: boolean = readyz?.checks?.storage === "ok";

let tcToken: string;
let nxToken: string;
let poToken: string;
let empToken: string;
let empId = 0;
let tcEventId = 0;
let nxEventId = 0;
let tcUserId = 0;
const createdScheduleIds: number[] = [];

beforeAll(async () => {
  [tcToken, nxToken, poToken] = await Promise.all([login(TECHCORP), login(NEXUS), login(PLATFORM)]);

  // Permission-less employee in TechCorp: employees are opt-in for reports:view,
  // so a fresh one (permissions {}) must be denied everywhere in this module.
  const emp = await api("POST", "/users", tcToken, {
    email: EMP_EMAIL,
    name: "B9 Permless Employee",
    role: "employee",
    password: EMP_PASSWORD,
  });
  if (emp.status !== 201) throw new Error(`employee setup failed: ${emp.status}`);
  empId = (await emp.json()).id;
  empToken = await login({ email: EMP_EMAIL, password: EMP_PASSWORD });

  const me = await api("GET", "/auth/me", tcToken).then((r) => r.json());
  tcUserId = me.id ?? me.user?.id;

  // One event per tenant for the report + isolation checks.
  const tcEvents = await api("GET", "/events", tcToken).then((r) => r.json());
  tcEventId = tcEvents.events?.[0]?.id ?? tcEvents[0]?.id;
  if (!tcEventId) {
    const created = await api("POST", "/events", tcToken, { name: "B9 Report Event", startDate: "2026-08-01", endDate: "2026-08-02" });
    tcEventId = (await created.json()).id;
  }
  const nxCreated = await api("POST", "/events", nxToken, { name: "B9 Nexus Event", startDate: "2026-08-01", endDate: "2026-08-02" });
  if (nxCreated.status !== 201) throw new Error(`nexus event setup failed: ${nxCreated.status}`);
  nxEventId = (await nxCreated.json()).id;
});

afterAll(async () => {
  if (nxEventId) await api("DELETE", `/events/${nxEventId}`, nxToken);
  for (const id of createdScheduleIds) {
    await api("DELETE", `/exports/schedules/${id}`, tcToken);
    await api("DELETE", `/exports/schedules/${id}`, nxToken);
  }
  if (empId) {
    await db.delete(usersTable).where(eq(usersTable.id, empId));
    await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, EMP_EMAIL));
  }
});

// ── 1. Access control ─────────────────────────────────────────────────────────
describe("reports/exports access control", () => {
  it("platform_owner is firewalled from reports (403)", async () => {
    expect((await api("GET", "/reports/leads-by-event", poToken)).status).toBe(403);
    expect((await api("GET", `/reports/event?eventId=${tcEventId}`, poToken)).status).toBe(403);
  });

  it("platform_owner is firewalled from exports (403)", async () => {
    expect((await api("GET", "/exports/runs", poToken)).status).toBe(403);
    expect((await api("POST", "/exports", poToken, { entityType: "contact", format: "csv" })).status).toBe(403);
    expect((await api("GET", "/exports/schedules", poToken)).status).toBe(403);
  });

  it("unauthenticated requests are rejected (401)", async () => {
    expect((await api("GET", "/reports/event?eventId=1")).status).toBe(401);
    expect((await api("GET", "/exports/runs")).status).toBe(401);
  });

  it("employee without reports:view is denied reports and exports (403)", async () => {
    expect((await api("GET", "/reports/leads-by-event", empToken)).status).toBe(403);
    expect((await api("GET", `/reports/event?eventId=${tcEventId}`, empToken)).status).toBe(403);
    expect((await api("GET", "/exports/runs", empToken)).status).toBe(403);
    expect((await api("POST", "/exports", empToken, { entityType: "contact", format: "csv" })).status).toBe(403);
    expect((await api("GET", "/exports/schedules", empToken)).status).toBe(403);
  });

  it("sanity: tenant primary_admin can read reports (200)", async () => {
    expect((await api("GET", "/reports/scan-activity", tcToken)).status).toBe(200);
  });
});

// ── 2. Event report ───────────────────────────────────────────────────────────
describe("event report", () => {
  it("returns the full report shape for an own-tenant event", async () => {
    const res = await api("GET", `/reports/event?eventId=${tcEventId}`, tcToken);
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.eventId).toBe(tcEventId);
    expect(typeof r.eventName).toBe("string");
    for (const k of ["totalLeads", "hotLeads", "warmLeads", "coldLeads", "meetings", "followUps", "wonDeals", "lostDeals", "pipelineValue"]) {
      expect(typeof r[k], k).toBe("number");
    }
    expect(r.qualificationDistribution).toEqual({ hot: r.hotLeads, warm: r.warmLeads, cold: r.coldLeads });
    for (const k of ["statusDistribution", "leadsByDay", "leadsByUser", "teamPerformance", "leadSourceBreakdown"]) {
      expect(Array.isArray(r[k]), k).toBe(true);
    }
    expect(r.hotLeads + r.warmLeads + r.coldLeads).toBeLessThanOrEqual(r.totalLeads);
  });

  it("applies the temperature filter", async () => {
    const all = await api("GET", `/reports/event?eventId=${tcEventId}`, tcToken).then((r) => r.json());
    const hot = await api("GET", `/reports/event?eventId=${tcEventId}&temperature=hot`, tcToken).then((r) => r.json());
    expect(hot.totalLeads).toBeLessThanOrEqual(all.totalLeads);
    expect(hot.warmLeads).toBe(0);
    expect(hot.coldLeads).toBe(0);
    expect(hot.hotLeads).toBe(hot.totalLeads);
  });

  it("returns an empty report for an out-of-range date window", async () => {
    const r = await api("GET", `/reports/event?eventId=${tcEventId}&dateFrom=2099-01-01&dateTo=2099-12-31`, tcToken).then((x) => x.json());
    expect(r.totalLeads).toBe(0);
    expect(r.leadsByDay).toEqual([]);
    expect(r.teamPerformance).toEqual([]);
  });

  it("requires eventId (400) and hides other tenants' events (404)", async () => {
    expect((await api("GET", "/reports/event", tcToken)).status).toBe(400);
    expect((await api("GET", `/reports/event?eventId=${nxEventId}`, tcToken)).status).toBe(404);
    expect((await api("GET", `/reports/event?eventId=${nxEventId}`, nxToken)).status).toBe(200);
  });
});

// ── 3. Team-member report ─────────────────────────────────────────────────────
describe("team-member report", () => {
  it("returns the member report shape", async () => {
    const res = await api("GET", `/reports/team-member?eventId=${tcEventId}&userId=${tcUserId}`, tcToken);
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.eventId).toBe(tcEventId);
    expect(r.userId).toBe(tcUserId);
    for (const k of ["totalLeads", "qualifiedLeads", "meetings", "followUps", "won", "lost", "pipelineValue", "conversionRate"]) {
      expect(typeof r[k], k).toBe("number");
    }
    expect(Array.isArray(r.activity)).toBe(true);
    expect(r.activity.length).toBeLessThanOrEqual(25);
  });

  it("requires both params (400)", async () => {
    expect((await api("GET", `/reports/team-member?eventId=${tcEventId}`, tcToken)).status).toBe(400);
    expect((await api("GET", `/reports/team-member?userId=${tcUserId}`, tcToken)).status).toBe(400);
  });

  it("hides cross-tenant events and members (404)", async () => {
    expect((await api("GET", `/reports/team-member?eventId=${tcEventId}&userId=${tcUserId}`, nxToken)).status).toBe(404);
  });
});

// ── 4. On-demand exports ──────────────────────────────────────────────────────
describe("on-demand exports", () => {
  it("validates entityType, format, and the password minimum (400)", async () => {
    expect((await api("POST", "/exports", tcToken, { entityType: "invoice", format: "csv" })).status).toBe(400);
    expect((await api("POST", "/exports", tcToken, { entityType: "contact", format: "xml" })).status).toBe(400);
    expect(
      (await api("POST", "/exports", tcToken, { entityType: "contact", format: "csv", passwordProtected: true, password: "short" })).status,
    ).toBe(400);
  });

  it("never persists an export password anywhere in the run row", async () => {
    const password = "B9-Sup3r-Secret-9821";
    // Succeeds (201) with storage, degrades (502) without — either way exactly
    // one run row is recorded and it must not contain the password.
    const res = await api("POST", "/exports", tcToken, {
      entityType: "contact",
      format: "csv",
      passwordProtected: true,
      password,
    });
    expect([201, 502]).toContain(res.status);
    const rows = await db.select().from(exportRunsTable);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  describe.runIf(STORAGE)("with object storage (completed files)", () => {
    it.each(["csv", "excel", "pdf", "json"] as const)("exports contacts as %s (201 completed + signed URL)", async (format) => {
      const res = await api("POST", "/exports", tcToken, { entityType: "contact", format });
      expect(res.status).toBe(201);
      const run = await res.json();
      expect(run.status).toBe("completed");
      expect(run.downloadUrl).toBeTruthy();
      expect(run.rowCount).toBeGreaterThan(0);
      expect(run.fileSize).toBeGreaterThan(0);
      expect(run.passwordProtected).toBe(false);
    });

    it("exports leads (201 completed)", async () => {
      const res = await api("POST", "/exports", tcToken, { entityType: "lead", format: "csv" });
      expect(res.status).toBe(201);
      expect((await res.json()).status).toBe("completed");
    });

    it("actually applies filters to the exported rows", async () => {
      const all = await api("POST", "/exports", tcToken, { entityType: "contact", format: "json" }).then((r) => r.json());
      const none = await api("POST", "/exports", tcToken, {
        entityType: "contact",
        format: "json",
        filters: { dateFrom: "2099-01-01", dateTo: "2099-12-31" },
      }).then((r) => r.json());
      expect(all.rowCount).toBeGreaterThan(0);
      expect(none.rowCount).toBe(0);
    });

    it("password-protects an on-demand export as an encrypted ZIP", async () => {
      const res = await api("POST", "/exports", tcToken, {
        entityType: "contact",
        format: "csv",
        passwordProtected: true,
        password: "unlock-me-123",
      });
      expect(res.status).toBe(201);
      const run = await res.json();
      expect(run.status).toBe("completed");
      expect(run.passwordProtected).toBe(true);
      expect(String(run.fileName)).toMatch(/\.zip$/);
    });
  });

  describe.runIf(!STORAGE)("without object storage (degraded, environment-gated)", () => {
    it("fails safely: 502 response and a recorded failed run", async () => {
      const res = await api("POST", "/exports", tcToken, { entityType: "contact", format: "csv" });
      expect(res.status).toBe(502);
      const runs = await api("GET", "/exports/runs?limit=5", tcToken).then((r) => r.json());
      expect(runs.runs.some((r: { status: string }) => r.status === "failed")).toBe(true);
    });
  });
});

// ── 5. Export history + signed download tenancy ──────────────────────────────
describe("export history and signed downloads", () => {
  let nxRunId = 0;

  beforeAll(async () => {
    // Ensure NexusSys has at least one run (completed with storage, failed without —
    // both are tenant-scoped history rows).
    await api("POST", "/exports", nxToken, { entityType: "contact", format: "csv" });
    const runs = await api("GET", "/exports/runs", nxToken).then((r) => r.json());
    nxRunId = runs.runs[0]?.id ?? 0;
    expect(nxRunId).toBeGreaterThan(0);
  });

  it("lists runs with pagination", async () => {
    const page1 = await api("GET", "/exports/runs?page=1&limit=1", tcToken).then((r) => r.json());
    expect(Array.isArray(page1.runs)).toBe(true);
    expect(page1.runs.length).toBeLessThanOrEqual(1);
    expect(typeof page1.total).toBe("number");
    if (page1.total > 1) {
      const page2 = await api("GET", "/exports/runs?page=2&limit=1", tcToken).then((r) => r.json());
      expect(page2.runs[0]?.id).not.toBe(page1.runs[0]?.id);
    }
  });

  it("run history is tenant-isolated", async () => {
    const tcRuns = await api("GET", "/exports/runs?limit=200", tcToken).then((r) => r.json());
    expect(tcRuns.runs.map((r: { id: number }) => r.id)).not.toContain(nxRunId);
  });

  it("cross-tenant download of another tenant's run is refused (404)", async () => {
    const res = await api("GET", `/exports/runs/${nxRunId}/download`, tcToken);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Export not found");
  });

  it.runIf(STORAGE)("owner gets a signed URL for a completed run", async () => {
    const created = await api("POST", "/exports", tcToken, { entityType: "contact", format: "csv" }).then((r) => r.json());
    const res = await api("GET", `/exports/runs/${created.id}/download`, tcToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(String(body.url)).toMatch(/^https?:\/\//);
    expect(body.fileName).toBe(created.fileName);
  });
});

// ── 6. Schedules ──────────────────────────────────────────────────────────────
describe("export schedules", () => {
  let scheduleId = 0;
  let nxScheduleId = 0;

  it.each(["daily", "weekly", "monthly"] as const)("creates a %s schedule (201, future nextRunAt)", async (frequency) => {
    const res = await api("POST", "/exports/schedules", tcToken, {
      name: `B9 ${frequency} schedule`,
      entityType: "contact",
      format: "csv",
      frequency,
      filters: { temperature: "hot" },
    });
    expect(res.status).toBe(201);
    const s = await res.json();
    createdScheduleIds.push(s.id);
    expect(s.frequency).toBe(frequency);
    expect(s.active).toBe(true);
    expect(s.passwordProtected).toBe(false);
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    if (frequency === "weekly") scheduleId = s.id;
  });

  it("refuses password protection on schedules (400, create and update)", async () => {
    const res = await api("POST", "/exports/schedules", tcToken, {
      name: "B9 protected schedule",
      entityType: "contact",
      format: "csv",
      frequency: "daily",
      passwordProtected: true,
    });
    expect(res.status).toBe(400);
    const upd = await api("PATCH", `/exports/schedules/${scheduleId}`, tcToken, { passwordProtected: true });
    expect(upd.status).toBe(400);
  });

  it("never stores a password on schedule rows", async () => {
    const rows = await db.select().from(exportSchedulesTable).where(inArray(exportSchedulesTable.id, createdScheduleIds));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.passwordProtected).toBe(false);
      expect(Object.keys(row).join(",")).not.toMatch(/password(?!Protected)/i);
    }
  });

  it("edits name/format and recomputes nextRunAt on frequency change", async () => {
    const before = await api("GET", "/exports/schedules", tcToken).then((r) => r.json());
    const orig = before.schedules.find((s: { id: number }) => s.id === scheduleId);
    const res = await api("PATCH", `/exports/schedules/${scheduleId}`, tcToken, {
      name: "B9 renamed schedule",
      format: "excel",
      frequency: "monthly",
    });
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.name).toBe("B9 renamed schedule");
    expect(s.format).toBe("excel");
    expect(s.frequency).toBe("monthly");
    expect(s.nextRunAt).not.toBe(orig.nextRunAt);
  });

  it("deactivates and reactivates", async () => {
    const off = await api("PATCH", `/exports/schedules/${scheduleId}`, tcToken, { active: false }).then((r) => r.json());
    expect(off.active).toBe(false);
    const on = await api("PATCH", `/exports/schedules/${scheduleId}`, tcToken, { active: true }).then((r) => r.json());
    expect(on.active).toBe(true);
  });

  it("run-now produces a run for this schedule (completed with storage, safe 502 without)", async () => {
    const res = await api("POST", `/exports/schedules/${scheduleId}/run`, tcToken);
    if (STORAGE) {
      expect(res.status).toBe(201);
      const run = await res.json();
      expect(run.status).toBe("completed");
      expect(run.scheduleId).toBe(scheduleId);
      const list = await api("GET", "/exports/schedules", tcToken).then((r) => r.json());
      expect(list.schedules.find((s: { id: number }) => s.id === scheduleId).lastRunAt).toBeTruthy();
    } else {
      expect(res.status).toBe(502);
      const runs = await api("GET", `/exports/runs?scheduleId=${scheduleId}`, tcToken).then((r) => r.json());
      expect(runs.runs.some((r: { scheduleId: number | null; status: string }) => r.scheduleId === scheduleId && r.status === "failed")).toBe(true);
    }
  });

  it("schedules are tenant-isolated (list, update, run, delete)", async () => {
    const created = await api("POST", "/exports/schedules", nxToken, {
      name: "B9 nexus schedule",
      entityType: "lead",
      format: "json",
      frequency: "daily",
    });
    expect(created.status).toBe(201);
    nxScheduleId = (await created.json()).id;
    createdScheduleIds.push(nxScheduleId);

    const tcList = await api("GET", "/exports/schedules", tcToken).then((r) => r.json());
    expect(tcList.schedules.map((s: { id: number }) => s.id)).not.toContain(nxScheduleId);
    expect((await api("PATCH", `/exports/schedules/${nxScheduleId}`, tcToken, { name: "hijack" })).status).toBe(404);
    expect((await api("POST", `/exports/schedules/${nxScheduleId}/run`, tcToken)).status).toBe(404);
    expect((await api("DELETE", `/exports/schedules/${nxScheduleId}`, tcToken)).status).toBe(404);
  });

  it("deletes with confirmation semantics (gone afterwards)", async () => {
    const res = await api("DELETE", `/exports/schedules/${scheduleId}`, tcToken);
    expect(res.status).toBe(200);
    const list = await api("GET", "/exports/schedules", tcToken).then((r) => r.json());
    expect(list.schedules.map((s: { id: number }) => s.id)).not.toContain(scheduleId);
    expect((await api("PATCH", `/exports/schedules/${scheduleId}`, tcToken, { name: "zombie" })).status).toBe(404);
  });
});
