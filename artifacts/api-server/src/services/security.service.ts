import type { AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { config } from "../config.js";
import * as securityRepo from "../repositories/security.repository.js";
import * as authRepo from "../repositories/auth.repository.js";

// Platform defaults returned when a company has no explicit policy row yet.
const DEFAULT_POLICY = {
  passwordMinLength: 8,
  passwordRequireUppercase: true,
  passwordRequireNumber: true,
  passwordRequireSymbol: false,
  sessionTimeoutMinutes: null as number | null,
  mfaRequired: false,
  allowedEmailDomains: [] as string[],
  blockedEmailDomains: [] as string[],
  allowedIps: [] as string[],
  allowedCountries: [] as string[],
};

// Resolves the company a caller manages. platform_owner may target a company via
// the optional companyId; everyone else is bound to their own company.
function resolveCompanyId(user: AuthUser, companyId?: number): number {
  if (user.role === "platform_owner") {
    const cid = companyId ?? user.companyId;
    if (cid == null) throw new AppError(400, "companyId is required");
    return cid;
  }
  if (user.companyId == null) throw new AppError(400, "Your account has no company");
  if (companyId != null && companyId !== user.companyId && !user.accessibleCompanies.includes(companyId)) {
    throw new AppError(404, "Company not found");
  }
  return companyId && user.accessibleCompanies.includes(companyId) ? companyId : user.companyId;
}

function format(companyId: number, row: securityRepo.SecurityPolicyRow | undefined) {
  if (!row) return { companyId, ...DEFAULT_POLICY };
  return {
    companyId: row.companyId,
    passwordMinLength: row.passwordMinLength,
    passwordRequireUppercase: row.passwordRequireUppercase,
    passwordRequireNumber: row.passwordRequireNumber,
    passwordRequireSymbol: row.passwordRequireSymbol,
    sessionTimeoutMinutes: row.sessionTimeoutMinutes,
    mfaRequired: row.mfaRequired,
    allowedEmailDomains: row.allowedEmailDomains,
    blockedEmailDomains: row.blockedEmailDomains,
    allowedIps: row.allowedIps,
    allowedCountries: row.allowedCountries,
    updatedAt: row.updatedAt,
  };
}

export async function getPolicy(user: AuthUser, companyId?: number) {
  const cid = resolveCompanyId(user, companyId);
  return format(cid, await securityRepo.getPolicy(cid));
}

export interface PolicyInput {
  companyId?: number;
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireNumber?: boolean;
  passwordRequireSymbol?: boolean;
  sessionTimeoutMinutes?: number | null;
  mfaRequired?: boolean;
  allowedEmailDomains?: string[];
  blockedEmailDomains?: string[];
  allowedIps?: string[];
  allowedCountries?: string[];
}

const normDomains = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : undefined;
const normList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((d) => String(d).trim()).filter(Boolean) : undefined;

export async function updatePolicy(user: AuthUser, input: PolicyInput) {
  const cid = resolveCompanyId(user, input.companyId);
  const patch: Partial<securityRepo.SecurityPolicyRow> = {};
  if (typeof input.passwordMinLength === "number") patch.passwordMinLength = Math.max(6, Math.min(128, input.passwordMinLength));
  if (typeof input.passwordRequireUppercase === "boolean") patch.passwordRequireUppercase = input.passwordRequireUppercase;
  if (typeof input.passwordRequireNumber === "boolean") patch.passwordRequireNumber = input.passwordRequireNumber;
  if (typeof input.passwordRequireSymbol === "boolean") patch.passwordRequireSymbol = input.passwordRequireSymbol;
  if (input.sessionTimeoutMinutes === null || typeof input.sessionTimeoutMinutes === "number") patch.sessionTimeoutMinutes = input.sessionTimeoutMinutes;
  if (typeof input.mfaRequired === "boolean") patch.mfaRequired = input.mfaRequired;
  const allowedEmailDomains = normDomains(input.allowedEmailDomains);
  const blockedEmailDomains = normDomains(input.blockedEmailDomains);
  const allowedIps = normList(input.allowedIps);
  const allowedCountries = input.allowedCountries ? normList(input.allowedCountries)?.map((c) => c.toUpperCase()) : undefined;
  if (allowedEmailDomains) patch.allowedEmailDomains = allowedEmailDomains;
  if (blockedEmailDomains) patch.blockedEmailDomains = blockedEmailDomains;
  if (allowedIps) patch.allowedIps = allowedIps;
  if (allowedCountries) patch.allowedCountries = allowedCountries;

  if (Object.keys(patch).length === 0) throw new AppError(400, "Nothing to update");

  const row = await securityRepo.upsertPolicy(cid, patch);
  // Keep companies.mfaRequired in sync so the existing login-enrollment gate and
  // this policy surface never disagree.
  if (typeof input.mfaRequired === "boolean") {
    await authRepo.updateCompany(cid, { mfaRequired: input.mfaRequired });
  }
  await securityRepo.insertEvent({
    companyId: cid,
    userId: user.id,
    type: "security_policy_updated",
    description: "Security policy updated",
    metadata: { actorId: user.id, actorEmail: user.email },
  });
  return format(cid, row);
}

export async function listEvents(user: AuthUser, limit = 100) {
  const events = await securityRepo.listEvents(user, Math.min(500, Math.max(1, limit)));
  return { events };
}

// Resolves which companies an alerts query covers. platform_owner sees all tenants by
// default and may narrow to one via companyId; everyone else is bound to their accessible
// companies (an out-of-scope companyId is ignored — never widens the view).
function alertCompanyScope(user: AuthUser, companyId?: number): number[] | undefined {
  if (user.role === "platform_owner") {
    return companyId != null ? [companyId] : undefined;
  }
  if (companyId != null && user.accessibleCompanies.includes(companyId)) return [companyId];
  return user.accessibleCompanies;
}

export async function getAlerts(user: AuthUser, windowHours = 24, companyId?: number) {
  const wh = Math.min(720, Math.max(1, Number.isFinite(windowHours) ? windowHours : 24));
  const since = new Date(Date.now() - wh * 3_600_000);
  const result = await securityRepo.getSecurityAlerts({
    companyIds: alertCompanyScope(user, companyId),
    since,
    threshold: config.security.maxFailedAttempts,
  });
  return { windowHours: wh, ...result, generatedAt: new Date().toISOString() };
}

// Enforced at login (after password verification) — returns a block reason when
// the attempt violates the company's policy, or null when allowed. Empty policy
// lists impose no restriction, so this is a no-op for companies without one.
export async function evaluateLoginPolicy(params: {
  companyId: number;
  email: string;
  ip: string | null;
  country: string | null;
}): Promise<string | null> {
  const policy = await securityRepo.getPolicy(params.companyId);
  if (!policy) return null;
  const domain = params.email.split("@")[1]?.toLowerCase() ?? "";
  if (policy.blockedEmailDomains.length > 0 && domain && policy.blockedEmailDomains.includes(domain)) {
    return "Your email domain is not permitted to sign in.";
  }
  if (policy.allowedEmailDomains.length > 0 && (!domain || !policy.allowedEmailDomains.includes(domain))) {
    return "Your email domain is not permitted to sign in.";
  }
  if (policy.allowedIps.length > 0 && (!params.ip || !policy.allowedIps.includes(params.ip))) {
    return "Sign-in is not permitted from your network.";
  }
  if (policy.allowedCountries.length > 0 && (!params.country || !policy.allowedCountries.includes(params.country))) {
    return "Sign-in is not permitted from your location.";
  }
  return null;
}

export async function recordLoginBlock(params: {
  companyId: number;
  userId: number;
  email: string;
  ip: string | null;
  reason: string;
}): Promise<void> {
  await securityRepo.insertEvent({
    companyId: params.companyId,
    userId: params.userId,
    type: "login_policy_blocked",
    description: `Login blocked by security policy: ${params.email}`,
    ipAddress: params.ip,
    metadata: { reason: params.reason },
  });
}
