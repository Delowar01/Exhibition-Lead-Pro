import { db, invitationsTable, usersTable, userRolesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../middlewares/requireAuth.js";
import { normalizeRole } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { hashPassword } from "../lib/auth.js";
import { validatePassword } from "../lib/security.js";
import * as invitationsRepo from "../repositories/invitations.repository.js";
import * as usersRepo from "../repositories/users.repository.js";
import * as authRepo from "../repositories/auth.repository.js";
import * as rbacRepo from "../repositories/rbac.repository.js";
import { sendInvitationEmail, sendWelcomeEmail } from "../lib/email/index.js";
import { notifyUsers } from "./notifications.service.js";

// Invitable roles via this flow. platform_owner is never invitable.
const ROLE_RANK: Record<string, number> = { employee: 1, admin: 2, primary_admin: 3, platform_owner: 4 };
const roleRank = (r: string): number => ROLE_RANK[r] ?? 0;

function normalizeEmail(email: unknown): string {
  if (typeof email !== "string" || !email.includes("@")) throw new AppError(400, "A valid email is required");
  return email.trim().toLowerCase();
}

function publicView(inv: invitationsRepo.Invitation) {
  return {
    id: inv.id,
    companyId: inv.companyId,
    email: inv.email,
    name: inv.name,
    role: inv.role,
    status: inv.status,
    invitedByUserId: inv.invitedByUserId,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
    createdAt: inv.createdAt,
    // Honest delivery state for the management UI: queued ≠ delivered.
    emailStatus: inv.emailStatus,
    emailError: inv.emailError,
    emailUpdatedAt: inv.emailUpdatedAt,
  };
}

function isExpired(inv: invitationsRepo.Invitation): boolean {
  return inv.expiresAt.getTime() < Date.now();
}

export interface CreateInvitationInput {
  email?: unknown;
  name?: unknown;
  role?: unknown;
  roleIds?: unknown;
  companyId?: unknown;
}

export async function createInvitation(user: AuthUser, input: CreateInvitationInput) {
  const email = normalizeEmail(input.email);
  const role = typeof input.role === "string" && input.role ? input.role : "employee";
  if (!ROLE_RANK[role] || role === "platform_owner") throw new AppError(400, "Invalid role");
  // No privilege escalation: cannot invite someone to a role higher than your own.
  if (roleRank(role) > roleRank(user.role)) throw new AppError(403, "Cannot invite a role higher than your own");

  // Resolve target company. Non-platform admins can only invite into their own company.
  const isPlatform = user.role === "platform_owner";
  const requestedCompanyId =
    typeof input.companyId === "number" ? input.companyId : input.companyId ? parseInt(String(input.companyId)) : null;
  const companyId = isPlatform ? (requestedCompanyId ?? user.companyId ?? null) : user.companyId ?? null;
  if (!isPlatform && requestedCompanyId != null && requestedCompanyId !== user.companyId) {
    throw new AppError(403, "Forbidden");
  }
  if (companyId == null) throw new AppError(400, "companyId is required");

  // Validate custom RBAC roleIds against the TARGET company (not just inviter
  // accessibility) — a multi-tenant inviter must not attach a role from another
  // company to this invite.
  const roleIds = Array.from(
    new Set(
      (Array.isArray(input.roleIds) ? input.roleIds.map((r) => Number(r)) : []).filter((n) => Number.isInteger(n)),
    ),
  );
  if (roleIds.length > 0) {
    const bad = await rbacRepo.firstInaccessibleRole(user, roleIds);
    if (bad != null) throw new AppError(400, "One or more roles are not assignable");
    const foreign = await rbacRepo.firstRoleNotInCompany(roleIds, companyId);
    if (foreign != null) throw new AppError(400, "One or more roles do not belong to the target company");

    // Anti-escalation parity with users.service#setUserRoles: a caller who does not
    // bypass permission checks may only attach roles whose grants are a subset of
    // their own effective permissions — otherwise an invite is a back door to
    // granting authority the inviter does not hold.
    if (user.role !== "platform_owner" && user.role !== "primary_admin") {
      const granted = await rbacRepo.permissionsForRoles(roleIds);
      const held = user.permissions ?? {};
      for (const [module, actions] of Object.entries(granted)) {
        const owned = new Set(held[module] ?? []);
        for (const action of actions) {
          if (!owned.has(action)) {
            throw new AppError(403, `Cannot grant ${module}:${action} — you do not hold this permission`);
          }
        }
      }
    }
  }

  // Reject if an active account already exists for this email.
  const existing = await authRepo.findUserByEmail(email);
  if (existing) throw new AppError(409, "A user with that email already exists");

  // Reject duplicate pending invitation for the same email+company.
  const pending = await invitationsRepo.findPendingForEmail(companyId, email);
  if (pending && !isExpired(pending)) throw new AppError(409, "An invitation is already pending for this email");

  const raw = randomToken();
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + config.tokens.invitationTtlDays * 24 * 60 * 60 * 1000);

  const inv = await invitationsRepo.insert({
    companyId,
    email,
    name: typeof input.name === "string" ? input.name : null,
    role,
    roleIds,
    invitedByUserId: user.id,
    tokenHash,
    status: "pending",
    expiresAt,
  });

  const companyName = (await usersRepo.companyName(companyId)) ?? "your team";
  const sendResult = await sendInvitationEmail({
    to: email,
    inviterName: user.name ?? null,
    companyName,
    link: `${config.email.appBaseUrl.replace(/\/$/, "")}/accept-invite/${raw}`,
    expiresAt,
    invitationId: inv.id,
  });

  // Sync-path outcomes (or an immediate skip) are recorded by the email layer;
  // re-read so the response reflects the freshest delivery state instead of the
  // optimistic "queued" default.
  const fresh = sendResult.queued ? inv : ((await invitationsRepo.findById(inv.id)) ?? inv);
  return { invitation: publicView(fresh) };
}

export async function listInvitations(
  user: AuthUser,
  companyId?: number,
  opts: invitationsRepo.ListInvitationsOpts = {},
) {
  const { rows, total } = await invitationsRepo.list(user, companyId, opts);
  return { invitations: rows.map(publicView), total };
}

// Loads an invitation the caller is allowed to manage (tenant-scoped). 404 on
// cross-tenant to avoid leaking existence.
async function loadManageable(user: AuthUser, id: number): Promise<invitationsRepo.Invitation> {
  const inv = await invitationsRepo.findById(id);
  if (!inv) throw new AppError(404, "Invitation not found");
  if (user.role !== "platform_owner" && !user.accessibleCompanies.includes(inv.companyId)) {
    throw new AppError(404, "Invitation not found");
  }
  return inv;
}

export async function resendInvitation(user: AuthUser, id: number) {
  const inv = await loadManageable(user, id);
  if (inv.status !== "pending") throw new AppError(400, "Only pending invitations can be resent");

  const raw = randomToken();
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + config.tokens.invitationTtlDays * 24 * 60 * 60 * 1000);
  // Resend supersedes the previous token (overwrite) and resets the delivery state
  // to queued — the previous outcome no longer describes the new email.
  const updated = await invitationsRepo.update(id, {
    tokenHash,
    expiresAt,
    status: "pending",
    emailStatus: "queued",
    emailError: null,
    emailUpdatedAt: new Date(),
  });

  const companyName = (await usersRepo.companyName(inv.companyId)) ?? "your team";
  const sendResult = await sendInvitationEmail({
    to: inv.email,
    inviterName: user.name ?? null,
    companyName,
    link: `${config.email.appBaseUrl.replace(/\/$/, "")}/accept-invite/${raw}`,
    expiresAt,
    invitationId: id,
  });

  const fresh = sendResult.queued ? updated! : ((await invitationsRepo.findById(id)) ?? updated!);
  return { invitation: publicView(fresh) };
}

export async function cancelInvitation(user: AuthUser, id: number) {
  const inv = await loadManageable(user, id);
  if (inv.status !== "pending") throw new AppError(400, "Only pending invitations can be cancelled");
  const updated = await invitationsRepo.update(id, { status: "cancelled" });
  return { invitation: publicView(updated!) };
}

// --- Public, token-based flows (no auth) ---

// Loads a live invitation by raw token, transitioning stale pending rows to expired.
async function loadByToken(rawToken: unknown): Promise<invitationsRepo.Invitation> {
  if (typeof rawToken !== "string" || rawToken.length < 16) throw new AppError(400, "Invalid invitation token");
  const inv = await invitationsRepo.findByTokenHash(sha256(rawToken));
  if (!inv) throw new AppError(404, "Invitation not found");
  if (inv.status === "pending" && isExpired(inv)) {
    await invitationsRepo.update(inv.id, { status: "expired" });
    throw new AppError(410, "This invitation has expired");
  }
  return inv;
}

export async function getInvitationByToken(rawToken: unknown) {
  const inv = await loadByToken(rawToken);
  const companyName = await usersRepo.companyName(inv.companyId);
  return {
    invitation: {
      email: inv.email,
      name: inv.name,
      role: inv.role,
      status: inv.status,
      companyName: companyName ?? null,
      expiresAt: inv.expiresAt,
    },
  };
}

export interface AcceptInvitationInput {
  token?: unknown;
  name?: unknown;
  password?: unknown;
}

export async function acceptInvitation(input: AcceptInvitationInput) {
  const inv = await loadByToken(input.token);
  if (inv.status !== "pending") throw new AppError(409, "This invitation is no longer active");

  // Guard against a race where an account was created after the invite was issued.
  const existing = await authRepo.findUserByEmail(inv.email);
  if (existing) {
    await invitationsRepo.update(inv.id, { status: "accepted", acceptedAt: new Date(), acceptedUserId: existing.id });
    throw new AppError(409, "An account already exists for this email. Please sign in.");
  }

  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : (inv.name ?? inv.email);
  const password = typeof input.password === "string" ? input.password : "";
  const pw = validatePassword(password);
  if (!pw.valid) throw new AppError(400, pw.errors.join(". "));

  // Atomic acceptance (Batch 3): claim the invitation, create the user, and assign
  // roles in ONE transaction so a mid-flight failure can never leave a user without
  // roles, an accepted invitation without a user, or a double-accepted invitation.
  // The row lock on the invitation serializes concurrent accepts of the same token.
  const created = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.id, inv.id))
      .for("update");
    if (!locked || locked.status !== "pending") throw new AppError(409, "This invitation is no longer active");
    if (locked.expiresAt.getTime() < Date.now()) throw new AppError(410, "This invitation has expired");

    const [user] = await tx
      .insert(usersTable)
      .values({
        email: inv.email,
        passwordHash: hashPassword(password),
        name,
        role: inv.role,
        companyId: inv.companyId,
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning();

    if (inv.roleIds.length > 0) {
      await tx.insert(userRolesTable).values(inv.roleIds.map((roleId) => ({ userId: user.id, roleId })));
    }

    await tx
      .update(invitationsTable)
      .set({ status: "accepted", acceptedAt: new Date(), acceptedUserId: user.id, updatedAt: new Date() })
      .where(eq(invitationsTable.id, inv.id));

    return user;
  });

  const companyName = await usersRepo.companyName(inv.companyId);
  await sendWelcomeEmail({ to: inv.email, name, companyName });

  // Notify the inviter (and surface in their feed) that the invite was accepted.
  if (inv.invitedByUserId) {
    await notifyUsers([inv.invitedByUserId], {
      companyId: inv.companyId,
      category: "invitations",
      title: "Invitation accepted",
      body: `${name} (${inv.email}) has joined ${companyName ?? "your team"}.`,
      link: "/admin/team",
    });
  }

  return {
    success: true,
    user: { id: created.id, email: created.email, name: created.name, role: normalizeRole(created.role) },
  };
}

export async function rejectInvitation(input: { token?: unknown }) {
  const inv = await loadByToken(input.token);
  if (inv.status !== "pending") throw new AppError(409, "This invitation is no longer active");
  await invitationsRepo.update(inv.id, { status: "rejected" });
  return { success: true };
}
