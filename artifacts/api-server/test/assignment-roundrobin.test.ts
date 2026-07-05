import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  teamsTable,
  leadsTable,
  leadHistoryTable,
  assignmentCursorsTable,
} from "@workspace/db";
import { assignByRoundRobin } from "../src/repositories/leads.repository.js";
import { bulkAssign, assignLead } from "../src/services/leads.service.js";
import type { AuthUser } from "../src/middlewares/requireAuth.js";

// Round-robin regression tests. These exercise the repository directly (no HTTP)
// so they assert the rotation INVARIANT rather than a route: with N ordered
// members, consecutive round-robin assignments must strictly rotate
// m0,m1,...,m(N-1),m0,... — and that rotation must be driven by a PERSISTENT
// cursor, so it keeps advancing even when the same lead is reassigned or when
// leads are deleted (a count-based cursor would repeat or drift in those cases).

const RR = "http://localhost:80/api";
const stamp = Date.now();

let companyId: number;
let otherCompanyId: number;
let teamId: number;
let otherTeamId: number;
const memberIds: number[] = [];
const otherMemberIds: number[] = [];
const leadIds: number[] = [];
const createdUserIds: number[] = [];
const createdTeamIds: number[] = [];
const createdCompanyIds: number[] = [];

async function makeMember(cId: number, tId: number, suffix: string): Promise<number> {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `rr-${stamp}-${suffix}@example.com`,
      passwordHash: "x",
      name: `RR Member ${suffix}`,
      role: "employee",
      companyId: cId,
      teamId: tId,
      isActive: true,
    })
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function makeLead(cId: number, tId: number): Promise<number> {
  const [l] = await db.insert(leadsTable).values({ companyId: cId, teamId: tId, stage: "prospect" }).returning();
  leadIds.push(l.id);
  return l.id;
}

// Assign a lead via the repo; makeHistory is exercised (returns one row) to mirror
// the real call path. Returns the chosen assignee id.
async function assign(cId: number, tId: number, leadId: number): Promise<number> {
  const res = await assignByRoundRobin(cId, tId, leadId, (assigneeId) => [
    { leadId, changedBy: null, fieldName: "assignedToId", oldValue: null, newValue: String(assigneeId) },
  ]);
  if (!res) throw new Error("assignByRoundRobin returned undefined");
  return res.assigneeId;
}

beforeAll(async () => {
  // Ensure the live API/db is reachable (matches the other integration suites).
  const health = await fetch(`${RR}/healthz`).catch(() => null);
  if (!health || !health.ok) throw new Error("API server not reachable at localhost:80 — start the api-server workflow");

  const [company] = await db.insert(companiesTable).values({ name: `RR Co ${stamp}` }).returning();
  companyId = company.id;
  createdCompanyIds.push(company.id);
  const [other] = await db.insert(companiesTable).values({ name: `RR Co2 ${stamp}` }).returning();
  otherCompanyId = other.id;
  createdCompanyIds.push(other.id);

  const [team] = await db.insert(teamsTable).values({ companyId, name: `RR Team ${stamp}` }).returning();
  teamId = team.id;
  createdTeamIds.push(team.id);
  const [otherTeam] = await db.insert(teamsTable).values({ companyId: otherCompanyId, name: `RR Team2 ${stamp}` }).returning();
  otherTeamId = otherTeam.id;
  createdTeamIds.push(otherTeam.id);

  // 3 ordered members in the primary pool; 2 in the isolated pool.
  memberIds.push(await makeMember(companyId, teamId, "a"));
  memberIds.push(await makeMember(companyId, teamId, "b"));
  memberIds.push(await makeMember(companyId, teamId, "c"));
  otherMemberIds.push(await makeMember(otherCompanyId, otherTeamId, "x"));
  otherMemberIds.push(await makeMember(otherCompanyId, otherTeamId, "y"));
});

afterAll(async () => {
  if (leadHistoryTable && leadIds.length) await db.delete(leadHistoryTable).where(inArray(leadHistoryTable.leadId, leadIds));
  if (leadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, leadIds));
  if (createdUserIds.length) await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  for (const cId of createdCompanyIds) await db.delete(assignmentCursorsTable).where(eq(assignmentCursorsTable.companyId, cId));
  if (createdTeamIds.length) await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds));
  if (createdCompanyIds.length) await db.delete(companiesTable).where(inArray(companiesTable.id, createdCompanyIds));
});

describe("assignByRoundRobin — true rotation", () => {
  it("rotates strictly across consecutive assignments (distinct leads)", async () => {
    const [m0, m1, m2] = memberIds;
    const leads = [await makeLead(companyId, teamId), await makeLead(companyId, teamId), await makeLead(companyId, teamId), await makeLead(companyId, teamId)];
    const seq: number[] = [];
    for (const l of leads) seq.push(await assign(companyId, teamId, l));
    // Fresh pool starts at position 0 → m0, m1, m2, then wraps to m0.
    expect(seq).toEqual([m0, m1, m2, m0]);
  });

  it("keeps advancing when the SAME lead is reassigned repeatedly (persistent cursor, not lead-count)", async () => {
    const [m0, m1, m2] = memberIds;
    const lead = await makeLead(companyId, teamId);
    const first = await assign(companyId, teamId, lead);
    const second = await assign(companyId, teamId, lead);
    const third = await assign(companyId, teamId, lead);
    // Cursor was at position 4 after the previous test (4 assigns), so this
    // continues 4,5,6 → m1, m2, m0. The key invariant: three consecutive
    // reassignments of one lead produce three DIFFERENT owners (a count-based
    // cursor would repeat because the assigned-lead count never changes).
    expect(new Set([first, second, third]).size).toBe(3);
    expect([first, second, third]).toEqual([m1, m2, m0]);
  });

  it("keeps advancing after an assigned lead is deleted (deletion does not rewind the cursor)", async () => {
    const [m0, m1] = memberIds;
    const lead = await makeLead(companyId, teamId);
    const before = await assign(companyId, teamId, lead); // position 7 → m1
    expect(before).toBe(m1);
    // Hard-delete the just-assigned lead. A count-based cursor would now see one
    // fewer assigned lead and could repeat; the persistent cursor must not.
    await db.delete(leadHistoryTable).where(eq(leadHistoryTable.leadId, lead));
    await db.delete(leadsTable).where(eq(leadsTable.id, lead));
    leadIds.splice(leadIds.indexOf(lead), 1);
    const next = await assign(companyId, teamId, await makeLead(companyId, teamId)); // position 8 → m2
    expect(next).toBe(memberIds[2]);
    // And the following one wraps back to m0, proving uninterrupted rotation.
    const after = await assign(companyId, teamId, await makeLead(companyId, teamId)); // position 9 → m0
    expect(after).toBe(m0);
  });

  it("maintains an independent cursor per tenant/pool", async () => {
    const [x0, x1] = otherMemberIds;
    const leads = [await makeLead(otherCompanyId, otherTeamId), await makeLead(otherCompanyId, otherTeamId), await makeLead(otherCompanyId, otherTeamId)];
    const seq: number[] = [];
    for (const l of leads) seq.push(await assign(otherCompanyId, otherTeamId, l));
    // This pool has never been touched → starts fresh at 0 regardless of how far
    // the primary pool's cursor advanced.
    expect(seq).toEqual([x0, x1, x0]);
  });

  it("survives concurrent assignments without double-assigning a slot", async () => {
    // Fire many assigns for the primary pool in parallel; the advisory lock must
    // serialize them so the multiset of owners is evenly distributed (each of the
    // 3 members gets exactly 3 of 9), with no lost increments.
    const leads = await Promise.all(Array.from({ length: 9 }, () => makeLead(companyId, teamId)));
    const results = await Promise.all(leads.map((l) => assign(companyId, teamId, l)));
    const counts = new Map<number, number>();
    for (const id of results) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const m of memberIds) expect(counts.get(m)).toBe(3);
  });
});

describe("bulkAssign — manual assignment preserves existing team binding", () => {
  // A primary_admin caller for the test company (bypasses permission checks).
  // Uses a real seeded user id so the assignment-history FK (changed_by) holds.
  function caller(): AuthUser {
    return {
      id: memberIds[0],
      email: `rr-${stamp}-a@example.com`,
      name: "RR Member a",
      role: "primary_admin",
      companyId,
      permissions: {},
      contactVisibility: "all",
      companyVisibility: "all",
      selectedUserIds: [],
      isActive: true,
      companyStatus: "active",
      readOnly: false,
      accessibleCompanies: [companyId],
      sessionId: null,
    };
  }

  it("does NOT clear teamId when a manual bulk assign omits teamId", async () => {
    const leadA = await makeLead(companyId, teamId);
    const leadB = await makeLead(companyId, teamId);
    // Manual bulk owner-only reassignment: teamId omitted (undefined).
    const res = await bulkAssign(caller(), { leadIds: [leadA, leadB], strategy: "manual", assignedToId: memberIds[1] });
    expect(res.assigned).toBe(2);
    const rows = await db.select({ id: leadsTable.id, teamId: leadsTable.teamId, assignedToId: leadsTable.assignedToId }).from(leadsTable).where(inArray(leadsTable.id, [leadA, leadB]));
    for (const r of rows) {
      expect(r.teamId).toBe(teamId); // preserved
      expect(r.assignedToId).toBe(memberIds[1]); // owner updated
    }
  });

  it("DOES clear teamId only when manual assign explicitly sends teamId: null", async () => {
    const lead = await makeLead(companyId, teamId);
    await assignLead(caller(), lead, { strategy: "manual", assignedToId: memberIds[2], teamId: null });
    const [r] = await db.select({ teamId: leadsTable.teamId, assignedToId: leadsTable.assignedToId }).from(leadsTable).where(eq(leadsTable.id, lead));
    expect(r.teamId).toBeNull(); // explicitly cleared
    expect(r.assignedToId).toBe(memberIds[2]);
  });
});
