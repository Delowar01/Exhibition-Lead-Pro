import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import crypto from "node:crypto";
import {
  db,
  companiesTable,
  usersTable,
  rolesTable,
  invitationsTable,
  notificationsTable,
  notificationPreferencesTable,
  verificationTokensTable,
  loginAttemptsTable,
} from "@workspace/db";

// Phase 2.5 — Email & Notification infrastructure: invitation lifecycle (create /
// list / resend / cancel + public accept / reject / expiry), in-app notifications
// (feed, unread-count, mark-read, read-all, delete, preferences), and the graceful
// no-SMTP path (email send must never surface a 500). These run against the LIVE API
// (localhost:80) like the other integration suites; all fixtures live under a
// throwaway tenant and are torn down in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const ORG_DOMAIN = `phase25qa-${SUFFIX}.test`;
const ORG_ADMIN_EMAIL = `qa-admin@${ORG_DOMAIN}`;

// sha256 hex — mirrors lib/crypto.ts so we can seed token-hashed invitations and
// drive the public accept/reject/expiry flows without scraping an email.
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

let companyId = 0;
let platformToken = "";
let orgToken = "";
let orgAdminId = 0;
const acceptedUserEmails: string[] = [];

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function rawLogin(creds: { email: string; password: string }) {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await rawLogin(creds);
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Public (no-auth) call helper for the invitation accept/reject screens.
async function pub(method: string, path: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);

  const createCo = await api("POST", "/companies", platformToken, { name: `QA Phase25 ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const createAdmin = await api("POST", "/users", platformToken, {
    email: ORG_ADMIN_EMAIL,
    name: "QA Org Admin",
    role: "primary_admin",
    companyId,
    password: PW,
  });
  expect(createAdmin.status).toBe(201);
  orgAdminId = (await createAdmin.json()).id;

  orgToken = await loginToken({ email: ORG_ADMIN_EMAIL, password: PW });
});

afterAll(async () => {
  // Children first: notifications + preferences + verification tokens key off users;
  // invitations + users cascade off the company. Accepted invitees are extra users
  // created under this tenant — they cascade off the company too, but clean by email
  // as well in case the company delete is blocked.
  await db.delete(notificationsTable).where(eq(notificationsTable.userId, orgAdminId));
  await db.delete(notificationPreferencesTable).where(eq(notificationPreferencesTable.userId, orgAdminId));
  await db.delete(verificationTokensTable).where(eq(verificationTokensTable.userId, orgAdminId));
  await db.delete(invitationsTable).where(eq(invitationsTable.companyId, companyId));
  if (acceptedUserEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, acceptedUserEmails));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
  await db.delete(usersTable).where(eq(usersTable.id, orgAdminId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("Invitation management (authed)", () => {
  let invId = 0;

  it("creates an invitation (201) and lists it as pending", async () => {
    const res = await api("POST", "/invitations", orgToken, {
      email: `qa-invitee@${ORG_DOMAIN}`,
      name: "QA Invitee",
      role: "employee",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitation.email).toBe(`qa-invitee@${ORG_DOMAIN}`);
    expect(body.invitation.status).toBe("pending");
    expect(body.invitation.companyId).toBe(companyId);
    invId = body.invitation.id;

    const list = await api("GET", "/invitations", orgToken);
    expect(list.status).toBe(200);
    const invitations = (await list.json()).invitations;
    expect(invitations.some((i: { id: number }) => i.id === invId)).toBe(true);
  });

  it("rejects a role higher than the caller's own (no escalation)", async () => {
    const res = await api("POST", "/invitations", orgToken, {
      email: `qa-escalate@${ORG_DOMAIN}`,
      role: "platform_owner",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a duplicate pending invitation for the same email (409)", async () => {
    const res = await api("POST", "/invitations", orgToken, {
      email: `qa-invitee@${ORG_DOMAIN}`,
      role: "employee",
    });
    expect(res.status).toBe(409);
  });

  it("resends a pending invitation (rotates token, stays pending)", async () => {
    const res = await api("POST", `/invitations/${invId}/resend`, orgToken);
    expect(res.status).toBe(200);
    expect((await res.json()).invitation.status).toBe("pending");
  });

  it("cancels a pending invitation, after which resend is rejected", async () => {
    const cancel = await api("DELETE", `/invitations/${invId}`, orgToken);
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).invitation.status).toBe("cancelled");

    const resend = await api("POST", `/invitations/${invId}/resend`, orgToken);
    expect(resend.status).toBe(400);
  });

  it("blocks privilege escalation via invitation roleIds (subset enforcement)", async () => {
    // primary_admin mints a custom role carrying security.edit, plus an admin who
    // does NOT hold it. The admin then attempts to attach that powerful role to an
    // invitation — which must 403, mirroring the users.service#setUserRoles guard.
    const superRole = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Inv Super ${SUFFIX}`,
      permissions: [{ module: "security", action: "edit" }],
    });
    expect(superRole.status).toBe(201);
    const superRoleId = (await superRole.json()).id;

    const createAdmin = await api("POST", "/users", orgToken, {
      email: `qa-invadmin@${ORG_DOMAIN}`,
      name: "QA Inv Admin",
      role: "admin",
      password: PW,
    });
    expect(createAdmin.status).toBe(201);

    // Grant the admin only team.create (so it can invite at all) — not security.edit.
    const teamRole = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Inv Team ${SUFFIX}`,
      permissions: [
        { module: "team", action: "view" },
        { module: "team", action: "create" },
      ],
    });
    expect(teamRole.status).toBe(201);
    const teamRoleId = (await teamRole.json()).id;
    const adminId = (await api("GET", "/users", orgToken).then((r) => r.json())).users.find(
      (u: { email: string }) => u.email === `qa-invadmin@${ORG_DOMAIN}`,
    ).id;
    expect((await api("PUT", `/users/${adminId}/roles`, orgToken, { roleIds: [teamRoleId] })).status).toBe(200);

    const adminToken = await loginToken({ email: `qa-invadmin@${ORG_DOMAIN}`, password: PW });
    const escalate = await api("POST", "/invitations", adminToken, {
      email: `qa-escinvitee@${ORG_DOMAIN}`,
      role: "employee",
      roleIds: [superRoleId],
    });
    expect(escalate.status).toBe(403);
  });

  it("rejects an invitation roleId that belongs to a different company (400)", async () => {
    // Seed a throwaway company B with a custom role, then (as platform owner) try to
    // attach company B's role to an invite into company A — must 400.
    const createB = await api("POST", "/companies", platformToken, { name: `QA Phase25 B ${SUFFIX}`, plan: "free" });
    expect(createB.status).toBe(201);
    const companyB = (await createB.json()).id;
    try {
      const [roleB] = await db
        .insert(rolesTable)
        .values({ companyId: companyB, name: `QA B Role ${SUFFIX}`, isSystem: false })
        .returning();

      const res = await api("POST", "/invitations", platformToken, {
        email: `qa-foreignrole@${ORG_DOMAIN}`,
        role: "employee",
        companyId,
        roleIds: [roleB.id],
      });
      expect(res.status).toBe(400);
    } finally {
      await db.delete(rolesTable).where(eq(rolesTable.companyId, companyB));
      await db.delete(companiesTable).where(eq(companiesTable.id, companyB));
    }
  });

  it("does not leak another tenant's invitation (cross-tenant 404)", async () => {
    // Seed an invitation under a foreign tenant (companyId 2 = TechCorp seed) and
    // confirm this caller cannot resend/cancel it.
    const raw = `qa-foreign-${SUFFIX}-${crypto.randomBytes(8).toString("hex")}`;
    const [foreign] = await db
      .insert(invitationsTable)
      .values({
        companyId: 2,
        email: `qa-foreign@${ORG_DOMAIN}`,
        role: "employee",
        tokenHash: sha256(raw),
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    try {
      const res = await api("DELETE", `/invitations/${foreign.id}`, orgToken);
      expect(res.status).toBe(404);
    } finally {
      await db.delete(invitationsTable).where(eq(invitationsTable.id, foreign.id));
    }
  });
});

describe("Invitation public flows (accept / reject / expiry)", () => {
  // Seeds a pending invitation with a known raw token so we can drive the public
  // flows directly (the real token is only ever emailed).
  async function seedInvite(opts: { email: string; expiresAt?: Date; status?: string }) {
    const raw = `qa-tok-${crypto.randomBytes(24).toString("hex")}`;
    const [row] = await db
      .insert(invitationsTable)
      .values({
        companyId,
        email: opts.email,
        name: "Seeded Invitee",
        role: "employee",
        invitedByUserId: orgAdminId,
        tokenHash: sha256(raw),
        status: opts.status ?? "pending",
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      })
      .returning();
    return { raw, id: row.id };
  }

  it("fetches a pending invitation by token for the accept screen", async () => {
    const email = `qa-accept@${ORG_DOMAIN}`;
    const { raw } = await seedInvite({ email });
    const res = await pub("GET", `/invitations/token/${raw}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invitation.email).toBe(email);
    expect(body.invitation.status).toBe("pending");
  });

  it("accepts an invitation: creates the user, who can then log in", async () => {
    const email = `qa-accept2@${ORG_DOMAIN}`;
    acceptedUserEmails.push(email);
    const { raw } = await seedInvite({ email });
    const res = await pub("POST", "/invitations/accept", { token: raw, name: "Accepted User", password: PW });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe(email);

    const login = await rawLogin({ email, password: PW });
    expect(login.status).toBe(200);
  });

  it("rejects a weak password on accept (400)", async () => {
    const email = `qa-weak@${ORG_DOMAIN}`;
    const { raw } = await seedInvite({ email });
    const res = await pub("POST", "/invitations/accept", { token: raw, name: "Weak", password: "123" });
    expect(res.status).toBe(400);
  });

  it("rejects an invitation via the public reject flow", async () => {
    const email = `qa-reject@${ORG_DOMAIN}`;
    const { raw, id } = await seedInvite({ email });
    const res = await pub("POST", "/invitations/reject", { token: raw });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id));
    expect(row.status).toBe("rejected");
  });

  it("treats an expired invitation as 410 (and marks it expired)", async () => {
    const email = `qa-expired@${ORG_DOMAIN}`;
    const { raw, id } = await seedInvite({ email, expiresAt: new Date(Date.now() - 60_000) });
    const res = await pub("GET", `/invitations/token/${raw}`);
    expect(res.status).toBe(410);

    const [row] = await db.select().from(invitationsTable).where(eq(invitationsTable.id, id));
    expect(row.status).toBe("expired");
  });

  it("returns 404 for an unknown token", async () => {
    const res = await pub("GET", `/invitations/token/qa-nonexistent-${SUFFIX}-token-value`);
    expect(res.status).toBe(404);
  });
});

describe("Notifications", () => {
  let notifId = 0;

  it("surfaces an accepted-invite notification in the inviter's feed", async () => {
    // The accept test above notifies orgAdmin (the inviter). Confirm it landed.
    const res = await api("GET", "/notifications", orgToken);
    expect(res.status).toBe(200);
    const notifications = (await res.json()).notifications;
    expect(Array.isArray(notifications)).toBe(true);
    const accepted = notifications.find((n: { category: string }) => n.category === "invitations");
    expect(accepted).toBeTruthy();
    notifId = accepted.id;
  });

  it("reports an unread count and marks a single notification read", async () => {
    const before = await api("GET", "/notifications/unread-count", orgToken);
    expect(before.status).toBe(200);
    expect((await before.json()).count).toBeGreaterThan(0);

    const mark = await api("POST", `/notifications/${notifId}/read`, orgToken);
    expect(mark.status).toBe(200);
    expect((await mark.json()).success).toBe(true);
  });

  it("marks all notifications read (unread count drops to 0)", async () => {
    const all = await api("POST", "/notifications/read-all", orgToken);
    expect(all.status).toBe(200);
    expect((await all.json()).success).toBe(true);

    const count = await api("GET", "/notifications/unread-count", orgToken);
    expect((await count.json()).count).toBe(0);
  });

  it("deletes a notification", async () => {
    const res = await api("DELETE", `/notifications/${notifId}`, orgToken);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const gone = await api("GET", "/notifications", orgToken);
    const notifications = (await gone.json()).notifications;
    expect(notifications.some((n: { id: number }) => n.id === notifId)).toBe(false);
  });

  it("returns the full preference matrix with on/on defaults", async () => {
    const res = await api("GET", "/notifications/preferences", orgToken);
    expect(res.status).toBe(200);
    const preferences = (await res.json()).preferences;
    expect(Array.isArray(preferences)).toBe(true);
    const invitations = preferences.find((p: { category: string }) => p.category === "invitations");
    expect(invitations).toMatchObject({ inApp: true, email: true });
  });

  it("updates a category preference, then restores it", async () => {
    const off = await api("PATCH", "/notifications/preferences", orgToken, {
      category: "invitations",
      inApp: false,
      email: false,
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ category: "invitations", inApp: false, email: false });

    const restore = await api("PATCH", "/notifications/preferences", orgToken, {
      category: "invitations",
      inApp: true,
      email: true,
    });
    expect(restore.status).toBe(200);
  });

  it("rejects an invalid category (400)", async () => {
    const res = await api("PATCH", "/notifications/preferences", orgToken, {
      category: "not_a_category",
      inApp: true,
      email: true,
    });
    expect(res.status).toBe(400);
  });
});

describe("Graceful email (no-SMTP) path", () => {
  it("forgot-password never enumerates or 500s even with no SMTP configured", async () => {
    const known = await pub("POST", "/auth/forgot-password", { email: ORG_ADMIN_EMAIL });
    expect(known.status).toBe(200);

    const unknown = await pub("POST", "/auth/forgot-password", { email: `nobody-${SUFFIX}@${ORG_DOMAIN}` });
    expect(unknown.status).toBe(200);
  });

  it("creating an invitation still succeeds (201) when email send is a no-op", async () => {
    // The send path is best-effort; a missing SMTP config must not surface as a 5xx.
    const res = await api("POST", "/invitations", orgToken, {
      email: `qa-nosmtp@${ORG_DOMAIN}`,
      role: "employee",
    });
    expect(res.status).toBe(201);
  });
});
