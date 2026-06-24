import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db, auditLogsTable, contactsTable } from "@workspace/db";

// Audit-trail integration coverage (Stage 2, Part 16). Runs against the LIVE API at
// localhost:80 with seeded demo tenants. Verifies that auditMutations records an
// immutable row for successful writes (attributed to the caller + tenant), captures
// the entity id on id-scoped routes, that reads are NOT audited, that a rejected
// write is NOT audited, and that login is audited.
const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };

type Session = { token: string; companyId: number; userId: number };
type AuditRow = typeof auditLogsTable.$inferSelect;

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId, userId: body.user.id };
}

function authHeaders(s: Session) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` };
}

// Newest audit row id, or 0 when the table is empty. Used as a baseline so each test
// matches ONLY rows written after its own request — collision-proof against pre-existing
// rows regardless of clock skew or other suites' history.
async function maxAuditId(): Promise<number> {
  const [row] = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).orderBy(desc(auditLogsTable.id)).limit(1);
  return row?.id ?? 0;
}

// Poll for an audit row matching a predicate — auditMutations writes on res "finish",
// so the row may land just after the HTTP response is flushed.
async function pollAudit(where: ReturnType<typeof and>): Promise<AuditRow | undefined> {
  for (let i = 0; i < 25; i++) {
    const [hit] = await db.select().from(auditLogsTable).where(where).orderBy(desc(auditLogsTable.id)).limit(1);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

let tech: Session;
const createdContactIds: number[] = [];
const createdAuditIds: number[] = [];

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  expect(health.ok, `API health check failed at ${BASE}/healthz`).toBe(true);
  tech = await login(TECHCORP);
});

afterAll(async () => {
  // Remove the audit rows we asserted on and the contacts we created so the shared
  // demo tenant does not accumulate test rows.
  if (createdAuditIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.id, createdAuditIds));
  }
  if (createdContactIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
  }
});

describe("auditMutations — successful writes are recorded immutably", () => {
  it("records a contacts.post row attributed to the caller and tenant", async () => {
    const sinceId = await maxAuditId();
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ firstName: "Audit", lastName: "Probe", fullName: "Audit Probe" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    createdContactIds.push(created.id);

    const row = await pollAudit(
      and(
        eq(auditLogsTable.action, "contacts.post"),
        eq(auditLogsTable.userId, tech.userId),
        gt(auditLogsTable.id, sinceId),
      ),
    );
    expect(row, "expected a contacts.post audit row").toBeTruthy();
    createdAuditIds.push(row!.id);
    expect(row!.companyId).toBe(tech.companyId);
    expect(row!.userName).toBe(TECHCORP.email);
    expect((row!.metadata as { method?: string } | null)?.method).toBe("POST");
  });

  it("captures the entity id on an id-scoped write (PATCH /contacts/:id)", async () => {
    expect(createdContactIds.length).toBeGreaterThan(0);
    const id = createdContactIds[0];
    const sinceId = await maxAuditId();
    const res = await fetch(`${BASE}/contacts/${id}`, {
      method: "PATCH",
      headers: authHeaders(tech),
      body: JSON.stringify({ jobTitle: "Audited Title" }),
    });
    expect(res.status).toBe(200);

    const row = await pollAudit(
      and(
        eq(auditLogsTable.action, "contacts.patch"),
        eq(auditLogsTable.entityId, String(id)),
        gt(auditLogsTable.id, sinceId),
      ),
    );
    expect(row, "expected a contacts.patch audit row with the entity id").toBeTruthy();
    createdAuditIds.push(row!.id);
    expect(row!.companyId).toBe(tech.companyId);
  });

  it("does NOT audit read (GET) requests", async () => {
    const sinceId = await maxAuditId();
    const res = await fetch(`${BASE}/contacts`, { headers: authHeaders(tech) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const recent = await db
      .select()
      .from(auditLogsTable)
      .where(and(eq(auditLogsTable.companyId, tech.companyId), gt(auditLogsTable.id, sinceId)));
    for (const r of recent) {
      expect((r.metadata as { method?: string } | null)?.method).not.toBe("GET");
    }
  });

  it("does NOT audit a rejected write (validation 400)", async () => {
    const countPosts = async () =>
      (
        await db
          .select({ id: auditLogsTable.id })
          .from(auditLogsTable)
          .where(and(eq(auditLogsTable.action, "contacts.post"), eq(auditLogsTable.userId, tech.userId)))
      ).length;

    const before = await countPosts();
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 400));
    const after = await countPosts();
    expect(after).toBe(before);
  });
});

describe("writeAudit — authentication events", () => {
  it("records a user.login row for a fresh login", async () => {
    const sinceId = await maxAuditId();
    const s = await login(TECHCORP);
    const row = await pollAudit(
      and(
        eq(auditLogsTable.action, "user.login"),
        eq(auditLogsTable.userId, s.userId),
        gt(auditLogsTable.id, sinceId),
      ),
    );
    expect(row, "expected a user.login audit row").toBeTruthy();
    createdAuditIds.push(row!.id);
    expect(row!.companyId).toBe(s.companyId);
  });
});
