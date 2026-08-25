import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db, usersTable, sessionsTable, invitationsTable, userRolesTable, auditLogsTable } from "@workspace/db";
import { sha256, randomToken } from "../src/lib/crypto.js";
import { InProcessQueue } from "../src/lib/jobs/in-process-queue.js";
import { registerEmailHandler } from "../src/lib/jobs/handlers.js";
import { EMAIL_SEND_JOB, __setEmailProviderForTests, type EmailProvider } from "../src/lib/email/index.js";

// Batch 3 — Invitation lifecycle + email delivery-status tracking.
// Live-server integration tests use the deterministic token strategy (overwrite
// tokenHash in DB with the hash of a raw token known to the test). The delivery/
// retry/outcome tests run the real email job handler on an isolated in-process
// queue with a stub transport.

const BASE = "http://localhost:80/api";
const RUN = Date.now();
const ADMIN = { email: "admin@techcorp.com", password: "Admin123!" };
const STRONG_PW = "Str0ngPassw0rd!7";

let adminToken = "";

function invEmail(tag: string) {
  return `inv-${tag}-${RUN}@example.invalid`;
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createInvitation(email: string, extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/invitations", { email, name: null, role: "employee", companyId: null, ...extra }, adminToken);
  expect(res.status).toBe(201);
  const { invitation } = await res.json();
  return invitation as { id: number; emailStatus: string; status: string };
}

async function setKnownToken(id: number, raw: string) {
  await db.update(invitationsTable).set({ tokenHash: sha256(raw) }).where(eq(invitationsTable.id, id));
}

async function pollEmailStatus(id: number, expected: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id));
    if (row?.emailStatus === expected) return row.emailStatus;
    if (Date.now() - start > timeoutMs) return row?.emailStatus ?? "<missing>";
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  const res = await api("POST", "/auth/login", ADMIN);
  expect(res.status).toBe(200);
  adminToken = (await res.json()).token;
});

afterAll(async () => {
  const created = await db.select().from(usersTable).where(like(usersTable.email, `inv-%-${RUN}@example.invalid`));
  for (const u of created) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, u.id));
    await db.delete(userRolesTable).where(eq(userRolesTable.userId, u.id));
    await db.delete(auditLogsTable).where(eq(auditLogsTable.userId, u.id));
  }
  await db.delete(usersTable).where(like(usersTable.email, `inv-%-${RUN}@example.invalid`));
  await db.delete(invitationsTable).where(like(invitationsTable.email, `inv-%-${RUN}@example.invalid`));
});

describe("invitation creation + delivery status", () => {
  it("creates an invitation and honestly records the email outcome (skipped without SMTP)", async () => {
    const inv = await createInvitation(invEmail("create"));
    expect(["queued", "skipped"]).toContain(inv.emailStatus);
    // The async worker resolves the real outcome; without SMTP configured it must
    // land on `skipped` — never a fake "sent".
    expect(await pollEmailStatus(inv.id, "skipped")).toBe("skipped");
  });

  it("rejects a duplicate pending invitation for the same email", async () => {
    const email = invEmail("dup");
    await createInvitation(email);
    const res = await api("POST", "/invitations", { email, name: null, role: "employee", companyId: null }, adminToken);
    expect(res.status).toBe(409);
  });

  it("resend supersedes the old token and resets delivery status", async () => {
    const inv = await createInvitation(invEmail("resend"));
    const oldRaw = randomToken(24);
    await setKnownToken(inv.id, oldRaw);
    expect((await api("GET", `/invitations/token/${oldRaw}`)).status).toBe(200);

    const res = await api("POST", `/invitations/${inv.id}/resend`, undefined, adminToken);
    expect(res.status).toBe(200);
    // The old link is dead after resend.
    expect((await api("GET", `/invitations/token/${oldRaw}`)).status).toBe(404);
    // Delivery status was reset and resolved again by the worker.
    expect(await pollEmailStatus(inv.id, "skipped")).toBe("skipped");
  });
});

describe("invitation acceptance", () => {
  it("accepts atomically: creates the user, marks accepted, and is single-use", async () => {
    const email = invEmail("accept");
    const inv = await createInvitation(email);
    const raw = randomToken(24);
    await setKnownToken(inv.id, raw);

    const res = await api("POST", "/invitations/accept", { token: raw, name: "Accepted User", password: STRONG_PW });
    expect(res.status).toBe(200);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    expect(user).toBeDefined();
    expect(user.isActive).toBe(true);

    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, inv.id));
    expect(row.status).toBe("accepted");
    expect(row.acceptedUserId).toBe(user.id);

    // The new user can sign in.
    expect((await api("POST", "/auth/login", { email, password: STRONG_PW })).status).toBe(200);

    // Replaying the token cannot accept twice.
    const replay = await api("POST", "/invitations/accept", { token: raw, name: "X", password: STRONG_PW });
    expect([409, 410]).toContain(replay.status);
  });

  it("a failed acceptance leaves no partial state", async () => {
    const email = invEmail("weakpw");
    const inv = await createInvitation(email);
    const raw = randomToken(24);
    await setKnownToken(inv.id, raw);

    const res = await api("POST", "/invitations/accept", { token: raw, name: "Weak", password: "short" });
    expect(res.status).toBe(400);

    const users = await db.select().from(usersTable).where(eq(usersTable.email, email));
    expect(users.length).toBe(0);
    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, inv.id));
    expect(row.status).toBe("pending"); // still usable
  });

  it("rejects an expired invitation clearly and marks it expired", async () => {
    const email = invEmail("expired");
    const inv = await createInvitation(email);
    const raw = randomToken(24);
    await setKnownToken(inv.id, raw);
    await db.update(invitationsTable).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invitationsTable.id, inv.id));

    expect((await api("GET", `/invitations/token/${raw}`)).status).toBe(410);
    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, inv.id));
    expect(row.status).toBe("expired");
    const accept = await api("POST", "/invitations/accept", { token: raw, name: "Late", password: STRONG_PW });
    expect([409, 410]).toContain(accept.status);
  });

  it("supports reject and cancel, both of which kill the token", async () => {
    const rejEmail = invEmail("reject");
    const rej = await createInvitation(rejEmail);
    const rejRaw = randomToken(24);
    await setKnownToken(rej.id, rejRaw);
    expect((await api("POST", "/invitations/reject", { token: rejRaw })).status).toBe(200);
    const [rejRow] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, rej.id));
    expect(rejRow.status).toBe("rejected");

    const canEmail = invEmail("cancel");
    const can = await createInvitation(canEmail);
    const canRaw = randomToken(24);
    await setKnownToken(can.id, canRaw);
    expect((await api("DELETE", `/invitations/${can.id}`, undefined, adminToken)).status).toBe(200);
    const accept = await api("POST", "/invitations/accept", { token: canRaw, name: "X", password: STRONG_PW });
    expect([409, 410]).toContain(accept.status);
  });

  it("an accepted employee cannot create invitations (team:create gate)", async () => {
    const email = invEmail("rbac");
    const inv = await createInvitation(email);
    const raw = randomToken(24);
    await setKnownToken(inv.id, raw);
    expect((await api("POST", "/invitations/accept", { token: raw, name: "Emp", password: STRONG_PW })).status).toBe(200);
    const login = await api("POST", "/auth/login", { email, password: STRONG_PW });
    expect(login.status).toBe(200);
    const empToken = (await login.json()).token;
    const res = await api("POST", "/invitations", { email: invEmail("rbac2"), name: null, role: "employee", companyId: null }, empToken);
    expect(res.status).toBe(403);
  });
});

describe("email worker: delivery outcomes + retry (isolated queue, stub transport)", () => {
  function makeQueue() {
    const q = new InProcessQueue({
      driver: "in-process",
      concurrency: 1,
      maxAttempts: 3,
      backoffBaseMs: 5,
      backoffMaxMs: 20,
    });
    registerEmailHandler(q);
    q.start();
    return q;
  }

  async function insertBareInvitation(email: string) {
    const [row] = await db
      .insert(invitationsTable)
      .values({
        companyId: 2,
        email,
        name: null,
        role: "employee",
        roleIds: [],
        status: "pending",
        tokenHash: sha256(randomToken(24)),
        expiresAt: new Date(Date.now() + 86_400_000),
        emailStatus: "queued",
      })
      .returning();
    return row;
  }

  function msg(invitationId: number) {
    return {
      to: "worker-test@example.invalid",
      subject: "test",
      html: "<p>t</p>",
      text: "t",
      meta: { invitationId },
    };
  }

  function stub(send: EmailProvider["send"], configured = true): EmailProvider {
    return { name: "stub", isConfigured: () => configured, send };
  }

  afterAll(() => {
    __setEmailProviderForTests(null);
  });

  it("marks the invitation sent on successful delivery", async () => {
    const inv = await insertBareInvitation(invEmail("worker-sent"));
    __setEmailProviderForTests(stub(async () => ({ sent: true, messageId: "m-1" })));
    const q = makeQueue();
    await q.enqueue(EMAIL_SEND_JOB, msg(inv.id));
    expect(await pollEmailStatus(inv.id, "sent", 3000)).toBe("sent");
    await q.stop();
  });

  it("retries transient transport errors and succeeds on a later attempt", async () => {
    const inv = await insertBareInvitation(invEmail("worker-retry"));
    let calls = 0;
    __setEmailProviderForTests(
      stub(async () => {
        calls++;
        if (calls < 2) throw new Error("transient transport error");
        return { sent: true, messageId: "m-2" };
      }),
    );
    const q = makeQueue();
    await q.enqueue(EMAIL_SEND_JOB, msg(inv.id));
    expect(await pollEmailStatus(inv.id, "sent", 3000)).toBe("sent");
    expect(calls).toBe(2);
    await q.stop();
  });

  it("marks the invitation failed after exhausting retries — with a SANITIZED error", async () => {
    const inv = await insertBareInvitation(invEmail("worker-fail"));
    let calls = 0;
    // Worst case: the transport error embeds message-derived material (a
    // recipient address and a token-bearing URL). None of it may be persisted.
    const SENTINEL = `leak-${Date.now()}@example.test https://x.test/invite?token=SECRET`;
    __setEmailProviderForTests(
      stub(async () => {
        calls++;
        throw new Error(`SMTP connection refused for ${SENTINEL}`);
      }),
    );
    const q = makeQueue();
    await q.enqueue(EMAIL_SEND_JOB, msg(inv.id));
    expect(await pollEmailStatus(inv.id, "failed", 3000)).toBe("failed");
    expect(calls).toBe(3); // maxAttempts respected
    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, inv.id));
    expect(row.emailError).toBe("Email delivery failed (Error)"); // fixed message + class only
    expect(row.emailError).not.toContain("SMTP");
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    await q.stop();
  });

  it("marks the invitation skipped when no provider is configured", async () => {
    const inv = await insertBareInvitation(invEmail("worker-skip"));
    __setEmailProviderForTests(stub(async () => ({ sent: true }), false));
    const q = makeQueue();
    await q.enqueue(EMAIL_SEND_JOB, msg(inv.id));
    expect(await pollEmailStatus(inv.id, "skipped", 3000)).toBe("skipped");
    await q.stop();
  });
});
