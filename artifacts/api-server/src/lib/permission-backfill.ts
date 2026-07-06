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
