import { and, eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

// One-time, idempotent RBAC backfill for the Stage 5B `ai_copilot` permission module.
//
// The seed defaults (scripts/src/seed-demo.ts) only affect FRESH installs. Existing
// LIVE `admin`/`employee` rows carry a `permissions` jsonb that predates the module,
// so — because the copilot routes are `requirePermission("ai_copilot", ...)`-gated —
// those users would start getting 403s after this feature ships (the classic
// gated-read lockout trap). `platform_owner`/`primary_admin` bypass permission checks
// and need no backfill.
//
// Policy (mirrors the seed): admin => view/generate/use (default-on); employee => view
// ONLY — both writes (`generate` and `use`, which mutate) stay deny-by-default and must
// be explicitly granted. We ONLY touch rows that do NOT already carry an `ai_copilot`
// key, so the backfill is idempotent and never clobbers an explicit grant/revocation
// made by a primary_admin via Role & Permission Management.
export async function backfillAiCopilotPermissions(): Promise<{ admins: number; employees: number }> {
  const admins = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_copilot":["view","generate","use"]}'::jsonb` })
    .where(and(eq(usersTable.role, "admin"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_copilot')`))
    .returning({ id: usersTable.id });

  const employees = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_copilot":["view"]}'::jsonb` })
    .where(and(eq(usersTable.role, "employee"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_copilot')`))
    .returning({ id: usersTable.id });

  const result = { admins: admins.length, employees: employees.length };
  if (result.admins || result.employees) {
    logger.info(result, "Backfilled ai_copilot permissions for pre-existing users");
  }
  return result;
}

// One-time, idempotent RBAC backfill for the Stage 5F `ai_workflow` permission module.
// Same rationale + policy as the copilot backfill above: the workflow routes are
// `requirePermission("ai_workflow", ...)`-gated, so pre-existing admin/employee rows that
// predate the module would 403 without this. Policy (mirrors the seed): admin =>
// view/generate/accept (default-on); employee => view ONLY (generate/accept are writes and
// stay deny-by-default). Only touches rows that do NOT already carry an `ai_workflow` key.
export async function backfillAiWorkflowPermissions(): Promise<{ admins: number; employees: number }> {
  const admins = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_workflow":["view","generate","accept"]}'::jsonb` })
    .where(and(eq(usersTable.role, "admin"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_workflow')`))
    .returning({ id: usersTable.id });

  const employees = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_workflow":["view"]}'::jsonb` })
    .where(and(eq(usersTable.role, "employee"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_workflow')`))
    .returning({ id: usersTable.id });

  const result = { admins: admins.length, employees: employees.length };
  if (result.admins || result.employees) {
    logger.info(result, "Backfilled ai_workflow permissions for pre-existing users");
  }
  return result;
}

// One-time, idempotent RBAC backfill for the Stage 5C `ai_executive` permission module
// (Enterprise AI Executive Intelligence Center). Same rationale + policy as the copilot/
// workflow backfills: the executive routes are `requirePermission("ai_executive", ...)`-gated,
// so pre-existing admin/employee rows that predate the module would 403 without this. Policy
// (mirrors the seed): admin => view/generate/accept (default-on); employee => view ONLY
// (generate/accept are writes and stay deny-by-default). Only touches rows that do NOT already
// carry an `ai_executive` key.
export async function backfillAiExecutivePermissions(): Promise<{ admins: number; employees: number }> {
  const admins = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_executive":["view","generate","accept"]}'::jsonb` })
    .where(and(eq(usersTable.role, "admin"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_executive')`))
    .returning({ id: usersTable.id });

  const employees = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_executive":["view"]}'::jsonb` })
    .where(and(eq(usersTable.role, "employee"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_executive')`))
    .returning({ id: usersTable.id });

  const result = { admins: admins.length, employees: employees.length };
  if (result.admins || result.employees) {
    logger.info(result, "Backfilled ai_executive permissions for pre-existing users");
  }
  return result;
}

// One-time, idempotent RBAC backfill for the Stage 5D `ai_assistant` permission module
// (Enterprise AI Command Center). Same rationale + policy as the previous AI backfills:
// the assistant routes are `requirePermission("ai_assistant", ...)`-gated, so pre-existing
// admin/employee rows that predate the module would 403 without this. Policy (mirrors the
// seed): admin => view/use (default-on, the assistant is advisory-only and re-checks each
// underlying module's permission in-service); employee => view ONLY (`use` — starting
// conversations/sending messages — is a write and stays deny-by-default). Only touches
// rows that do NOT already carry an `ai_assistant` key.
export async function backfillAiAssistantPermissions(): Promise<{ admins: number; employees: number }> {
  const admins = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_assistant":["view","use"]}'::jsonb` })
    .where(and(eq(usersTable.role, "admin"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_assistant')`))
    .returning({ id: usersTable.id });

  const employees = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"ai_assistant":["view"]}'::jsonb` })
    .where(and(eq(usersTable.role, "employee"), sql`NOT jsonb_exists(${usersTable.permissions}, 'ai_assistant')`))
    .returning({ id: usersTable.id });

  const result = { admins: admins.length, employees: employees.length };
  if (result.admins || result.employees) {
    logger.info(result, "Backfilled ai_assistant permissions for pre-existing users");
  }
  return result;
}

// One-time, idempotent RBAC backfill for the Batch 15 `workflows` permission module
// (deterministic CRM automation definitions, /workflows). Same rationale as the AI
// module backfills: the routes are `requirePermission("workflows", ...)`-gated, so
// pre-existing `admin` rows that predate the module would 403 without this. Policy
// (mirrors the seed): admin => view/manage (default-on, it is an administrative
// configuration surface); employee => NOTHING by default (deny-by-default — an
// employee must be explicitly granted even read access). Only touches admin rows that
// do NOT already carry a `workflows` key, so an explicit grant/revocation is never
// clobbered.
export async function backfillWorkflowsPermissions(): Promise<{ admins: number }> {
  const admins = await db
    .update(usersTable)
    .set({ permissions: sql`${usersTable.permissions} || '{"workflows":["view","manage"]}'::jsonb` })
    .where(and(eq(usersTable.role, "admin"), sql`NOT jsonb_exists(${usersTable.permissions}, 'workflows')`))
    .returning({ id: usersTable.id });

  const result = { admins: admins.length };
  if (result.admins) {
    logger.info(result, "Backfilled workflows permissions for pre-existing admin users");
  }
  return result;
}
