import type { AuthUser } from "../../middlewares/requireAuth.js";
import * as runsRepo from "../../repositories/workflow_runs.repository.js";
import { WorkflowFailure } from "./errors.js";

// =============================================================================
// Execution principal (Batch 16). The existing CRM services take an AuthUser; a
// workflow action runs with SYSTEM authority inside ONE company, so the engine
// builds a principal that:
//   • is pinned to the run's company (accessibleCompanies = [companyId], so every
//     tenantScope read and refAccessible check is bounded to that tenant);
//   • bypasses the write-permission matrix like a primary_admin (a published
//     automation is administrator configuration);
//   • carries a REAL user id for created_by/assigned_by attribution: the actor who
//     caused the event when they are still an active member of the company,
//     otherwise the company's first active primary admin. No usable principal →
//     deterministic failure (never a cross-tenant or dangling attribution).
// It never carries a session and is never used for HTTP.
// =============================================================================

export async function buildPrincipal(companyId: number, actorUserId: number | null): Promise<AuthUser> {
  const actor = actorUserId != null ? await runsRepo.activeUserInCompany(companyId, actorUserId) : undefined;
  const user = actor ?? (await runsRepo.firstActivePrimaryAdmin(companyId));
  if (!user) throw new WorkflowFailure("PRINCIPAL_UNAVAILABLE", "No active user in the company can attribute this workflow run");
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: "primary_admin",
    companyId,
    permissions: {},
    contactVisibility: "all",
    companyVisibility: "own",
    selectedUserIds: [],
    isActive: true,
    companyStatus: "active",
    readOnly: false,
    accessibleCompanies: [companyId],
    sessionId: null,
  };
}
