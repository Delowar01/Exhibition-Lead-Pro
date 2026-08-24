// Batch 12 — CRM lifecycle gaps around Tasks, Follow-Ups and the Contact
// Timeline. Proves against the live API:
//   1. contacts.followUpDate/followUpTime mirror the NEAREST upcoming pending
//      scheduled follow-up (earliest date, earliest same-day time, unscheduled
//      pending rows never occupy the mirror, cleared when none remain), and the
//      mirror is recalculated after create/complete/cancel/reschedule/delete.
//   2. Follow-up lifecycle integrity: terminal rows (completed/rescheduled/
//      cancelled) are history — lifecycle actions only apply to pending rows,
//      rescheduling is atomic and preserves history as rows.
//   3. Task ownership: admins manage any company task; a normal user can only
//      mutate their OWN assigned tasks (404 for someone else's — they can't
//      list them either), and only admins assign to others.
//   4. Task and follow-up lifecycle actions surface in the contact's existing
//      Timeline (GET /contacts/:id/timeline) as system activity entries.
//   5. Tenant isolation for all of the above.
// All fixtures live in throwaway tenants torn down in afterAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like, inArray } from "drizzle-orm";
import {
  db,
  companiesTable,
  userCompanyAccessTable,
  usersTable,
  contactsTable,
  followUpsTable,
  tasksTable,
  leadActivitiesTable,
  loginAttemptsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `b12qa-${SUFFIX}.test`;
const DOMAIN_B = `b12qab-${SUFFIX}.test`;

let platformToken = "";
let companyId = 0;
let companyBId = 0;
let adminToken = "";
let emp1Token = "";
let emp2Token = "";
let adminBToken = "";
let adminId = 0;
let emp1Id = 0;
let emp2Id = 0;
let adminBId = 0;
let contact1 = 0; // mirror-ordering fixture
let contact2 = 0; // reschedule fixture
let contact3 = 0; // timeline fixture
let contactB1 = 0; // tenant B

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

async function contactMirror(token: string, contactId: number): Promise<{ followUpDate: string | null; followUpTime: string | null }> {
  const res = await api("GET", `/contacts/${contactId}`, token);
  expect(res.status).toBe(200);
  const body = await res.json();
  return { followUpDate: body.followUpDate ?? null, followUpTime: body.followUpTime ?? null };
}

async function createFollowUp(token: string, body: Record<string, unknown>) {
  return api("POST", "/follow-ups", token, body);
}

async function timelineEntries(token: string, contactId: number): Promise<any[]> {
  const res = await api("GET", `/contacts/${contactId}/timeline`, token);
  expect(res.status).toBe(200);
  return (await res.json()).entries;
}

beforeAll(async () => {
  platformToken = await loginToken(PLATFORM);

  const co = await api("POST", "/companies", platformToken, { name: `B12 QA ${SUFFIX}`, plan: "professional" });
  expect(co.status).toBe(201);
  companyId = (await co.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));
  const mkUser = async (email: string, name: string, role: string, cid: number) => {
    const res = await api("POST", "/users", platformToken, { email, name, role, password: PW, companyId: cid });
    expect(res.status, `create ${email}`).toBe(201);
    return (await res.json()).id as number;
  };
  adminId = await mkUser(`qa-admin@${DOMAIN}`, "B12 Admin", "primary_admin", companyId);
  emp1Id = await mkUser(`qa-emp1@${DOMAIN}`, "B12 Emp One", "employee", companyId);
  emp2Id = await mkUser(`qa-emp2@${DOMAIN}`, "B12 Emp Two", "employee", companyId);
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });
  emp1Token = await loginToken({ email: `qa-emp1@${DOMAIN}`, password: PW });
  emp2Token = await loginToken({ email: `qa-emp2@${DOMAIN}`, password: PW });

  const coB = await api("POST", "/companies", platformToken, { name: `B12 QA B ${SUFFIX}`, plan: "professional" });
  companyBId = (await coB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  adminBId = await mkUser(`qa-admin@${DOMAIN_B}`, "B12 Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: `qa-admin@${DOMAIN_B}`, password: PW });

  const rows = await db
    .insert(contactsTable)
    .values([
      { companyId, fullName: "B12 Mirror Contact", contactCompany: "Acme" },
      { companyId, fullName: "B12 Reschedule Contact", contactCompany: "Acme" },
      { companyId, fullName: "B12 Timeline Contact", contactCompany: "Acme" },
      { companyId: companyBId, fullName: "B12 Foreign Contact", contactCompany: "Globex" },
    ])
    .returning({ id: contactsTable.id });
  contact1 = rows[0].id;
  contact2 = rows[1].id;
  contact3 = rows[2].id;
  contactB1 = rows[3].id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, cid));
    await db.delete(followUpsTable).where(eq(followUpsTable.companyId, cid));
    await db.delete(tasksTable).where(eq(tasksTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN_B}`));
});

// Follow-up ids threaded through the ordered mirror tests.
let fuSep20 = 0;
let fuSep5 = 0;
let fuSep12 = 0;

describe("next-follow-up mirror: nearest upcoming pending wins", () => {
  it("with Sep 20, Sep 5 and Sep 12 pending, the contact points to Sep 5", async () => {
    const mk = async (scheduledDate: string) => {
      const res = await createFollowUp(adminToken, { contactId: contact1, scheduledDate, notes: `fu ${scheduledDate}` });
      expect(res.status).toBe(201);
      return (await res.json()).id as number;
    };
    fuSep20 = await mk("2026-09-20");
    fuSep5 = await mk("2026-09-05");
    fuSep12 = await mk("2026-09-12");

    expect((await contactMirror(adminToken, contact1)).followUpDate).toBe("2026-09-05");
  });

  it("completing Sep 5 promotes Sep 12", async () => {
    const res = await api("PATCH", `/follow-ups/${fuSep5}`, adminToken, { status: "completed", comment: "done" });
    expect(res.status).toBe(200);
    expect((await contactMirror(adminToken, contact1)).followUpDate).toBe("2026-09-12");
  });

  it("cancelling Sep 12 promotes Sep 20", async () => {
    const res = await api("PATCH", `/follow-ups/${fuSep12}`, adminToken, { status: "cancelled", comment: "no longer needed" });
    expect(res.status).toBe(200);
    expect((await contactMirror(adminToken, contact1)).followUpDate).toBe("2026-09-20");
  });

  it("deleting the final pending follow-up clears the mirror", async () => {
    const res = await api("DELETE", `/follow-ups/${fuSep20}`, adminToken);
    expect(res.status).toBe(200);
    const mirror = await contactMirror(adminToken, contact1);
    expect(mirror.followUpDate).toBeNull();
    expect(mirror.followUpTime).toBeNull();
  });

  it("same-day ties resolve to the earliest time, and an unscheduled pending row never occupies the mirror", async () => {
    const late = await createFollowUp(adminToken, { contactId: contact1, scheduledDate: "2026-10-01", scheduledTime: "14:00" });
    expect(late.status).toBe(201);
    const lateId = (await late.json()).id;
    const early = await createFollowUp(adminToken, { contactId: contact1, scheduledDate: "2026-10-01", scheduledTime: "09:00" });
    expect(early.status).toBe(201);
    const earlyId = (await early.json()).id;

    let mirror = await contactMirror(adminToken, contact1);
    expect(mirror.followUpDate).toBe("2026-10-01");
    expect(mirror.followUpTime).toBe("09:00");

    // A pending row with NO scheduled date must not replace a real one…
    const undated = await createFollowUp(adminToken, { contactId: contact1, notes: "someday" });
    expect(undated.status).toBe(201);
    const undatedId = (await undated.json()).id;
    mirror = await contactMirror(adminToken, contact1);
    expect(mirror.followUpDate).toBe("2026-10-01");
    expect(mirror.followUpTime).toBe("09:00");

    // …and once the scheduled ones are gone the mirror clears even though the
    // undated pending row still exists.
    expect((await api("DELETE", `/follow-ups/${earlyId}`, adminToken)).status).toBe(200);
    expect((await api("DELETE", `/follow-ups/${lateId}`, adminToken)).status).toBe(200);
    mirror = await contactMirror(adminToken, contact1);
    expect(mirror.followUpDate).toBeNull();
    expect(mirror.followUpTime).toBeNull();

    expect((await api("DELETE", `/follow-ups/${undatedId}`, adminToken)).status).toBe(200);
  });

  it("updating a pending follow-up's date recalculates the mirror", async () => {
    const res = await createFollowUp(adminToken, { contactId: contact1, scheduledDate: "2026-10-10" });
    const id = (await res.json()).id;
    expect((await contactMirror(adminToken, contact1)).followUpDate).toBe("2026-10-10");
    const upd = await api("PATCH", `/follow-ups/${id}`, adminToken, { scheduledDate: "2026-10-15" });
    expect(upd.status).toBe(200);
    expect((await contactMirror(adminToken, contact1)).followUpDate).toBe("2026-10-15");
    expect((await api("DELETE", `/follow-ups/${id}`, adminToken)).status).toBe(200);
  });
});

describe("reschedule keeps history and the mirror honest", () => {
  let early = 0; // Sep 5 → rescheduled to Sep 25
  let mid = 0; // Sep 12 stays pending

  it("rescheduling Sep 5 → Sep 25 leaves the mirror on the still-pending Sep 12", async () => {
    early = (await (await createFollowUp(adminToken, { contactId: contact2, scheduledDate: "2026-09-05" })).json()).id;
    mid = (await (await createFollowUp(adminToken, { contactId: contact2, scheduledDate: "2026-09-12" })).json()).id;
    expect((await contactMirror(adminToken, contact2)).followUpDate).toBe("2026-09-05");

    const res = await api("PATCH", `/follow-ups/${early}`, adminToken, {
      status: "rescheduled",
      scheduledDate: "2026-09-25",
      comment: "pushed out",
    });
    expect(res.status).toBe(200);
    const newRow = await res.json();
    expect(newRow.status).toBe("pending");
    expect(newRow.scheduledDate).toBe("2026-09-25");
    expect(newRow.id).not.toBe(early);

    // Mirror = nearest pending (Sep 12), NOT the rescheduled-to date.
    expect((await contactMirror(adminToken, contact2)).followUpDate).toBe("2026-09-12");

    // History preserved as rows: old row is terminal, both pendings exist.
    const list = await (await api("GET", `/follow-ups?contactId=${contact2}`, adminToken)).json();
    const byId = new Map(list.followUps.map((f: any) => [f.id, f]));
    expect((byId.get(early) as any).status).toBe("rescheduled");
    expect((byId.get(early) as any).comment).toBe("pushed out");
    expect((byId.get(newRow.id) as any).status).toBe("pending");
    expect((byId.get(mid) as any).status).toBe("pending");
  });

  it("lifecycle actions are rejected on terminal rows (no duplicate reschedules)", async () => {
    // The old row is already 'rescheduled' — acting on it again must fail…
    expect((await api("PATCH", `/follow-ups/${early}`, adminToken, { status: "rescheduled", scheduledDate: "2026-09-30" })).status).toBe(400);
    expect((await api("PATCH", `/follow-ups/${early}`, adminToken, { status: "completed" })).status).toBe(400);
    // …and no second "reschedule of the same row" pending copy appeared.
    const list = await (await api("GET", `/follow-ups?contactId=${contact2}`, adminToken)).json();
    expect(list.followUps.filter((f: any) => f.status === "pending")).toHaveLength(2);
  });

  it("an invalid status value is rejected by validation", async () => {
    expect((await api("PATCH", `/follow-ups/${mid}`, adminToken, { status: "snoozed" })).status).toBe(400);
  });
});

describe("task ownership: admins manage the company, users manage their own", () => {
  let ownTask = 0; // emp1's own task
  let otherTask = 0; // admin-created task for emp2

  it("a normal user creates a task for themselves but cannot assign to others", async () => {
    const own = await api("POST", "/tasks", emp1Token, { title: "B12 emp1 own task" });
    expect(own.status).toBe(201);
    const ownBody = await own.json();
    expect(ownBody.assignedToId).toBe(emp1Id);
    ownTask = ownBody.id;

    const res = await api("POST", "/tasks", emp1Token, { title: "B12 sneaky assign", assignedToId: emp2Id });
    expect(res.status).toBe(403);
  });

  it("a normal user cannot modify or delete another user's task in the same company", async () => {
    const created = await api("POST", "/tasks", adminToken, { title: "B12 emp2 task", assignedToId: emp2Id });
    expect(created.status).toBe(201);
    otherTask = (await created.json()).id;

    expect((await api("PATCH", `/tasks/${otherTask}`, emp1Token, { status: "completed" })).status).toBe(404);
    expect((await api("PATCH", `/tasks/${otherTask}`, emp1Token, { title: "hijacked" })).status).toBe(404);
    expect((await api("DELETE", `/tasks/${otherTask}`, emp1Token)).status).toBe(404);

    // The assignee themselves CAN work the task.
    expect((await api("PATCH", `/tasks/${otherTask}`, emp2Token, { status: "in_progress" })).status).toBe(200);
  });

  it("a normal user manages their own task through its lifecycle", async () => {
    expect((await api("PATCH", `/tasks/${ownTask}`, emp1Token, { status: "in_progress" })).status).toBe(200);
    expect((await api("PATCH", `/tasks/${ownTask}`, emp1Token, { status: "completed" })).status).toBe(200);
    // …but cannot reassign it to someone else.
    expect((await api("PATCH", `/tasks/${ownTask}`, emp1Token, { assignedToId: emp2Id })).status).toBe(403);
    expect((await api("DELETE", `/tasks/${ownTask}`, emp1Token)).status).toBe(200);
  });

  it("an admin edits, reassigns, completes and deletes any company task", async () => {
    expect((await api("PATCH", `/tasks/${otherTask}`, adminToken, { title: "B12 emp2 task (edited)" })).status).toBe(200);
    expect((await api("PATCH", `/tasks/${otherTask}`, adminToken, { assignedToId: emp1Id })).status).toBe(200);
    expect((await api("PATCH", `/tasks/${otherTask}`, adminToken, { status: "completed" })).status).toBe(200);
    expect((await api("DELETE", `/tasks/${otherTask}`, adminToken)).status).toBe(200);
  });

  it("a normal user's task list stays scoped to their own tasks", async () => {
    const mine = await api("POST", "/tasks", emp1Token, { title: "B12 emp1 visible task" });
    const mineId = (await mine.json()).id;
    const other = await api("POST", "/tasks", adminToken, { title: "B12 emp2 invisible task", assignedToId: emp2Id });
    const otherId = (await other.json()).id;

    const list = await (await api("GET", "/tasks?scope=all", emp1Token)).json();
    const ids = list.tasks.map((t: any) => t.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(otherId);

    expect((await api("DELETE", `/tasks/${mineId}`, emp1Token)).status).toBe(200);
    expect((await api("DELETE", `/tasks/${otherId}`, adminToken)).status).toBe(200);
  });
});

describe("tenant isolation for follow-ups, tasks and the timeline", () => {
  let fuA = 0;
  let taskA = 0;

  beforeAll(async () => {
    fuA = (await (await createFollowUp(adminToken, { contactId: contact1, scheduledDate: "2026-11-01" })).json()).id;
    taskA = (await (await api("POST", "/tasks", adminToken, { title: "B12 iso task" })).json()).id;
  });

  it("tenant B cannot read or mutate tenant A follow-ups", async () => {
    expect((await api("PATCH", `/follow-ups/${fuA}`, adminBToken, { notes: "hijacked" })).status).toBe(404);
    expect((await api("DELETE", `/follow-ups/${fuA}`, adminBToken)).status).toBe(404);
    const list = await (await api("GET", `/follow-ups?contactId=${contact1}`, adminBToken)).json();
    expect(list.followUps).toHaveLength(0);
  });

  it("tenant B cannot mutate tenant A tasks", async () => {
    expect((await api("PATCH", `/tasks/${taskA}`, adminBToken, { title: "hijacked" })).status).toBe(404);
    expect((await api("DELETE", `/tasks/${taskA}`, adminBToken)).status).toBe(404);
  });

  it("cross-tenant contact references are rejected", async () => {
    expect((await createFollowUp(adminBToken, { contactId: contact1, scheduledDate: "2026-11-02" })).status).toBe(404);
    expect((await api("POST", "/tasks", adminBToken, { title: "cross contact", contactId: contact1 })).status).toBe(400);
  });

  it("cross-tenant assignedToId references are rejected", async () => {
    expect((await createFollowUp(adminToken, { contactId: contact1, scheduledDate: "2026-11-03", assignedToId: adminBId })).status).toBe(400);
    expect((await api("POST", "/tasks", adminToken, { title: "cross assignee", assignedToId: adminBId })).status).toBe(400);
  });

  it("the contact timeline never leaks across tenants", async () => {
    expect((await api("GET", `/contacts/${contact1}/timeline`, adminBToken)).status).toBe(404);
    expect((await api("GET", `/contacts/${contactB1}/timeline`, adminToken)).status).toBe(404);
  });
});

describe("contact timeline reflects CRM lifecycle", () => {
  const entryOfType = (entries: any[], type: string) => entries.filter((e) => e.kind === "activity" && e.type === type);

  it("task creation, start and completion appear with actor and task identity", async () => {
    const created = await api("POST", "/tasks", adminToken, { title: "B12 timeline task", contactId: contact3, dueDate: "2026-09-30" });
    expect(created.status).toBe(201);
    const taskId = (await created.json()).id;
    expect((await api("PATCH", `/tasks/${taskId}`, adminToken, { status: "in_progress" })).status).toBe(200);
    expect((await api("PATCH", `/tasks/${taskId}`, adminToken, { status: "completed" })).status).toBe(200);

    const entries = await timelineEntries(adminToken, contact3);
    const createdEntry = entryOfType(entries, "task_created").find((e) => e.metadata?.taskId === taskId);
    expect(createdEntry).toBeTruthy();
    expect(createdEntry.source).toBe("system");
    expect(createdEntry.actorId).toBe(adminId);
    expect(createdEntry.title).toContain("B12 timeline task");

    const started = entryOfType(entries, "task_status_change").find((e) => e.metadata?.taskId === taskId);
    expect(started).toBeTruthy();
    expect(started.metadata.to).toBe("in_progress");

    const completed = entryOfType(entries, "task_completed").find((e) => e.metadata?.taskId === taskId);
    expect(completed).toBeTruthy();
  });

  it("follow-up scheduled / completed / rescheduled / cancelled all appear", async () => {
    const f1 = (await (await createFollowUp(adminToken, { contactId: contact3, scheduledDate: "2026-12-01", scheduledTime: "10:00" })).json()).id;
    expect((await api("PATCH", `/follow-ups/${f1}`, adminToken, { status: "completed", comment: "spoke on phone" })).status).toBe(200);

    const f2 = (await (await createFollowUp(adminToken, { contactId: contact3, scheduledDate: "2026-12-05" })).json()).id;
    const resched = await api("PATCH", `/follow-ups/${f2}`, adminToken, { status: "rescheduled", scheduledDate: "2026-12-12" });
    expect(resched.status).toBe(200);
    const f3 = (await resched.json()).id;
    expect((await api("PATCH", `/follow-ups/${f3}`, adminToken, { status: "cancelled", comment: "deal closed early" })).status).toBe(200);

    const entries = await timelineEntries(adminToken, contact3);
    const scheduled = entryOfType(entries, "follow_up_scheduled");
    expect(scheduled.some((e) => e.metadata?.followUpId === f1)).toBe(true);
    expect(scheduled.some((e) => e.metadata?.followUpId === f2)).toBe(true);
    expect(entryOfType(entries, "follow_up_completed").some((e) => e.metadata?.followUpId === f1)).toBe(true);
    const r = entryOfType(entries, "follow_up_rescheduled").find((e) => e.metadata?.followUpId === f3);
    expect(r).toBeTruthy();
    expect(r.metadata.previousFollowUpId).toBe(f2);
    expect(r.metadata.scheduledDate).toBe("2026-12-12");
    expect(entryOfType(entries, "follow_up_cancelled").some((e) => e.metadata?.followUpId === f3)).toBe(true);
  });

  it("existing timeline entries (logged communications) keep working alongside lifecycle events", async () => {
    const res = await api("POST", `/contacts/${contact3}/communications`, adminToken, { channel: "email", subject: "B12 intro email" });
    expect(res.status).toBe(201);
    const entries = await timelineEntries(adminToken, contact3);
    expect(entries.some((e) => e.kind === "activity" && e.type === "email" && (e.title ?? "").includes("B12 intro email"))).toBe(true);
    // Lifecycle events from the previous tests are still present.
    expect(entries.some((e) => e.type === "task_completed")).toBe(true);
    expect(entries.some((e) => e.type === "follow_up_scheduled")).toBe(true);
  });
});

// ── Final correction: terminal rows immutable + multi-company FK invariant ──
describe("terminal follow-up history is immutable", () => {
  let contactT = 0;
  let fuCompleted = 0;
  let fuCancelled = 0;
  let fuRescheduled = 0; // the OLD row of a reschedule

  const snapshot = async () => {
    const list = await (await api("GET", `/follow-ups?contactId=${contactT}`, adminToken)).json();
    const statuses = Object.fromEntries(list.followUps.map((f: any) => [f.id, f.status]));
    const pendingCount = list.followUps.filter((f: any) => f.status === "pending").length;
    const mirror = await contactMirror(adminToken, contactT);
    const timelineCount = (await timelineEntries(adminToken, contactT)).length;
    return { statuses, pendingCount, mirror, timelineCount };
  };

  beforeAll(async () => {
    const c = await api("POST", "/contacts", adminToken, { fullName: "B12 Terminal Contact", contactCompany: "Acme" });
    expect(c.status).toBe(201);
    contactT = (await c.json()).id;

    fuCompleted = (await (await createFollowUp(adminToken, { contactId: contactT, scheduledDate: "2026-12-20" })).json()).id;
    expect((await api("PATCH", `/follow-ups/${fuCompleted}`, adminToken, { status: "completed" })).status).toBe(200);

    fuCancelled = (await (await createFollowUp(adminToken, { contactId: contactT, scheduledDate: "2026-12-21" })).json()).id;
    expect((await api("PATCH", `/follow-ups/${fuCancelled}`, adminToken, { status: "cancelled" })).status).toBe(200);

    fuRescheduled = (await (await createFollowUp(adminToken, { contactId: contactT, scheduledDate: "2026-12-01" })).json()).id;
    expect((await api("PATCH", `/follow-ups/${fuRescheduled}`, adminToken, { status: "rescheduled", scheduledDate: "2026-12-05" })).status).toBe(200);
    // State now: completed + cancelled + old rescheduled row + ONE active pending (the reschedule target).
  });

  it("completed → pending is rejected", async () => {
    expect((await api("PATCH", `/follow-ups/${fuCompleted}`, adminToken, { status: "pending" })).status).toBe(400);
  });

  it("cancelled → pending is rejected", async () => {
    expect((await api("PATCH", `/follow-ups/${fuCancelled}`, adminToken, { status: "pending" })).status).toBe(400);
  });

  it("an old rescheduled row cannot reopen — and can never yield two active pending rows", async () => {
    const before = await snapshot();
    expect(before.pendingCount).toBe(1); // only the reschedule target is active

    const res = await api("PATCH", `/follow-ups/${fuRescheduled}`, adminToken, { status: "pending" });
    expect(res.status).toBe(400);

    // The rejected reopen is a pure no-op: statuses, active-pending count,
    // contact mirror and timeline activities are all untouched.
    expect(await snapshot()).toEqual(before);
  });

  it("terminal → other terminal transitions are rejected too", async () => {
    expect((await api("PATCH", `/follow-ups/${fuCompleted}`, adminToken, { status: "rescheduled", scheduledDate: "2026-12-30" })).status).toBe(400);
    expect((await api("PATCH", `/follow-ups/${fuCancelled}`, adminToken, { status: "completed" })).status).toBe(400);
    expect((await api("PATCH", `/follow-ups/${fuRescheduled}`, adminToken, { status: "completed" })).status).toBe(400);
    expect((await api("PATCH", `/follow-ups/${fuRescheduled}`, adminToken, { status: "cancelled" })).status).toBe(400);
  });

  it("pending → completed/cancelled/rescheduled still works", async () => {
    const id = (await (await createFollowUp(adminToken, { contactId: contactT, scheduledDate: "2027-01-05" })).json()).id;
    expect((await api("PATCH", `/follow-ups/${id}`, adminToken, { status: "completed", comment: "done" })).status).toBe(200);
  });
});

describe("multi-company access does not allow cross-company FK binding", () => {
  let dualToken = "";
  let dualId = 0;
  let dualTaskId = 0;

  beforeAll(async () => {
    // A user whose HOME company is A with a legitimate access grant to B.
    const res = await api("POST", "/users", platformToken, {
      email: `qa-dual@${DOMAIN}`, name: "B12 Dual Access", role: "admin", password: PW, companyId,
    });
    expect(res.status).toBe(201);
    dualId = (await res.json()).id;
    await db.insert(userCompanyAccessTable).values({ userId: dualId, companyId: companyBId });
    dualToken = await loginToken({ email: `qa-dual@${DOMAIN}`, password: PW });

    // Premise: the dual user really CAN read both companies' records.
    expect((await api("GET", `/contacts/${contact1}`, dualToken)).status).toBe(200);
    expect((await api("GET", `/contacts/${contactB1}`, dualToken)).status).toBe(200);
  });

  it("a company-A task cannot bind a company-B contact or assignee on create", async () => {
    expect((await api("POST", "/tasks", dualToken, { title: "cross contact", contactId: contactB1 })).status).toBe(400);
    expect((await api("POST", "/tasks", dualToken, { title: "cross assignee", assignedToId: adminBId })).status).toBe(400);
  });

  it("a company-A task cannot be updated to point at company-B records", async () => {
    const created = await api("POST", "/tasks", dualToken, { title: "B12 dual own task" });
    expect(created.status).toBe(201);
    dualTaskId = (await created.json()).id;

    expect((await api("PATCH", `/tasks/${dualTaskId}`, dualToken, { contactId: contactB1 })).status).toBe(400);
    expect((await api("PATCH", `/tasks/${dualTaskId}`, dualToken, { assignedToId: adminBId })).status).toBe(400);
  });

  it("a company-A follow-up cannot bind a company-B assignee", async () => {
    const res = await createFollowUp(dualToken, { contactId: contact1, scheduledDate: "2027-01-10", assignedToId: adminBId });
    expect(res.status).toBe(400);
  });

  it("legitimate same-company references still work", async () => {
    const task = await api("POST", "/tasks", dualToken, { title: "B12 legit task", contactId: contact1, assignedToId: emp1Id });
    expect(task.status).toBe(201);
    expect((await api("PATCH", `/tasks/${dualTaskId}`, dualToken, { contactId: contact1, assignedToId: emp1Id })).status).toBe(200);
    const fu = await createFollowUp(dualToken, { contactId: contact1, scheduledDate: "2027-01-12", assignedToId: emp1Id });
    expect(fu.status).toBe(201);
  });
});
