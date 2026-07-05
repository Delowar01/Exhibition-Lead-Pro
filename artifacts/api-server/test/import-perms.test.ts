import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, companiesTable, usersTable, loginAttemptsTable, contactsTable, customFieldDefinitionsTable } from "@workspace/db";

// Stage 4B — Import & Export Center: access-control regression coverage.
// The whole import flow (preview / validate / commit) is gated on the target
// module's create permission — not just commit — because validate performs
// duplicate detection that reveals which contacts/leads already exist in the
// tenant. Export is gated on reports:view. These run against the LIVE API
// (localhost:80) like the other integration suites; all fixtures live under a
// throwaway tenant torn down in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const ORG_DOMAIN = `importperms-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${ORG_DOMAIN}`;
const EMPLOYEE_EMAIL = `qa-employee@${ORG_DOMAIN}`;

const CSV_B64 = Buffer.from("name,email\nJohn Doe,john@sample.test\n").toString("base64");

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
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

let companyId = 0;
let platformToken = "";
let adminToken = "";
let employeeToken = "";

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);

  const createCo = await api("POST", "/companies", platformToken, { name: `QA ImportPerms ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const createAdmin = await api("POST", "/users", platformToken, {
    email: ADMIN_EMAIL,
    name: "QA Import Admin",
    role: "primary_admin",
    companyId,
    password: PW,
  });
  expect(createAdmin.status).toBe(201);

  // Employee with empty permissions: reads stay open but writes (and the
  // create-gated import/export flows) are deny-by-default.
  const createEmployee = await api("POST", "/users", platformToken, {
    email: EMPLOYEE_EMAIL,
    name: "QA Import Employee",
    role: "employee",
    companyId,
    password: PW,
    permissions: {},
  });
  expect(createEmployee.status).toBe(201);

  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  employeeToken = await loginToken({ email: EMPLOYEE_EMAIL, password: PW });
});

afterAll(async () => {
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
  await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
  await db.delete(customFieldDefinitionsTable).where(eq(customFieldDefinitionsTable.companyId, companyId));
  await db.delete(usersTable).where(like(usersTable.email, `%@${ORG_DOMAIN}`));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("Import flow is create-permission gated (all three steps)", () => {
  it("403s an employee without contacts:create on preview", async () => {
    const res = await api("POST", "/imports/preview", employeeToken, { entityType: "contact", file: CSV_B64 });
    expect(res.status).toBe(403);
  });

  it("403s an employee without contacts:create on validate (dup detection is gated)", async () => {
    const res = await api("POST", "/imports/validate", employeeToken, {
      entityType: "contact",
      file: CSV_B64,
      mapping: { name: "name", email: "email" },
    });
    expect(res.status).toBe(403);
  });

  it("403s an employee without contacts:create on commit", async () => {
    const res = await api("POST", "/imports/commit", employeeToken, {
      entityType: "contact",
      file: CSV_B64,
      mapping: { name: "name", email: "email" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a primary_admin (bypasses permission checks) to preview", async () => {
    const res = await api("POST", "/imports/preview", adminToken, { entityType: "contact", file: CSV_B64 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entityType).toBe("contact");
    expect(body.columns).toContain("name");
    expect(body.columns).toContain("email");
  });
});

describe("Export is reports:view gated", () => {
  it("403s an employee without reports:view", async () => {
    const res = await api("POST", "/exports", employeeToken, { entityType: "contact", format: "csv" });
    expect(res.status).toBe(403);
  });
});

describe("Import commit is atomic across base rows + custom-field writes", () => {
  it("rolls back the whole batch (no partial contact) when a custom-field write fails", async () => {
    // Create a contact custom field, then submit a mapping where TWO columns point
    // at the SAME custom field. Commit resolves two values with the same
    // (definitionId, entityId) → the second insert violates the def/entity unique
    // index → the transaction must abort, leaving NO contact behind.
    const created = await api("POST", "/custom-fields", adminToken, {
      entityType: "contact",
      fieldKey: `rollback_probe_${SUFFIX}`,
      label: "Rollback Probe",
      fieldType: "text",
    });
    expect(created.status).toBe(201);
    const defId = (await created.json()).id as number;

    const uniqueEmail = `atomic-rollback-${SUFFIX}@sample.test`;
    const file = Buffer.from(
      `name,email,c1,c2\nAtomic Rollback,${uniqueEmail},alpha,beta\n`,
    ).toString("base64");

    const commit = await api("POST", "/imports/commit", adminToken, {
      entityType: "contact",
      file,
      mapping: { name: "name", email: "email", c1: `cf:${defId}`, c2: `cf:${defId}` },
    });
    // The duplicate custom-field write must surface as a failure, not a success.
    expect(commit.ok).toBe(false);

    // Rollback assertion: the base contact was NOT persisted.
    const rows = await db.select().from(contactsTable).where(eq(contactsTable.email, uniqueEmail));
    expect(rows.length).toBe(0);
  });
});
