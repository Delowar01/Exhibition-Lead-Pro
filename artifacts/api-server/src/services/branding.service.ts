// =============================================================================
// Batch 18 — tenant branding service. One code path serves the tenant
// self-service routes (company always derived from the authenticated user) and
// the platform-owner routes (explicit company id). Every mutation:
//   • validates first (nothing is touched on invalid input),
//   • writes the NEW logo object before the database row and deletes the OLD
//     object only after the row committed — a failed storage operation therefore
//     leaves the previous branding exactly as it was,
//   • records an explicit audit entry (branding.update / branding.logo.replace /
//     branding.logo.remove / branding.reset) with safe metadata only,
//   • (B25 Correction 4) never lets a raw database / provider / filesystem
//     error escape: a failing company-row update is logged as its sanitized
//     shape and answered with a fixed, client-safe 503 (BRANDING_UPDATE_FAILED),
//   • (B25 Correction 5) never assumes a rejected company-row update did not
//     commit: the durable row is re-read and compared field by field with the
//     requested mutation — committed (resolved as success, normal cleanup and
//     audit), conclusively not committed (fixed 503, previous state kept, a
//     fresh unreferenced logo tombstoned) or unknown (fixed refresh-before-retry
//     503, NOTHING deleted, every object left represented in the inventory).
// =============================================================================
import type { Request } from "express";
import { AppError } from "../middlewares/errorHandler.js";
import type { AuthUser } from "../middlewares/requireAuth.js";
import * as companiesRepo from "../repositories/companies.repository.js";
import { writeAudit } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { sanitizeStorageError } from "../storage/log-safety.js";
import { resolveBranding, publicBranding, validateBrandingInput, type ResolvedBranding, type PublicBranding } from "../lib/branding/model.js";
import { validateLogoUpload } from "../lib/branding/logo.js";
import { deleteLogo, getLogo, keyBelongsTo, logoStorageAvailable, putLogo, storageUnavailable } from "../lib/branding/storage.js";

/** The company a tenant user may manage: always their own (never a body/query value). */
export function tenantCompanyId(user: AuthUser): number {
  if (user.role === "platform_owner") throw new AppError(403, "Platform operators manage branding through the companies API");
  if (user.companyId == null) throw new AppError(400, "Your account has no company");
  return user.companyId;
}

async function loadCompany(companyId: number): Promise<companiesRepo.CompanyRow> {
  const company = await companiesRepo.findById(companyId);
  if (!company) throw new AppError(404, "Organization not found");
  return company;
}

export async function getBranding(companyId: number): Promise<ResolvedBranding> {
  return resolveBranding(await loadCompany(companyId));
}

export async function getPublicBranding(companyId: number | null | undefined): Promise<PublicBranding | null> {
  if (companyId == null) return null;
  const company = await companiesRepo.findById(companyId);
  return company ? publicBranding(company) : null;
}

/** Fixed client-safe failure for a company-row write that conclusively did not happen (no cause, no message from the driver). */
function updateFailed(): AppError {
  return new AppError(503, "Branding could not be saved right now. Nothing was changed; please try again later.", { code: "BRANDING_UPDATE_FAILED" });
}
/** Fixed client-safe failure for a company-row write whose outcome could not be confirmed (it may have committed). */
function updateUnconfirmed(): AppError {
  return new AppError(503, "Branding update status could not be confirmed. Refresh the page before retrying.", { code: "BRANDING_UPDATE_UNCONFIRMED" });
}

type CompanyPatch = Parameters<typeof companiesRepo.update>[1];
type UpdateOutcome = { kind: "committed"; row: companiesRepo.CompanyRow } | { kind: "not_committed" } | { kind: "unknown" };
/** Bookkeeping columns that never decide whether the mutation committed. */
const UNTRACKED_FIELDS: ReadonlySet<string> = new Set(["updatedAt"]);
const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

/**
 * B25 Correction 5 — classify the DURABLE outcome of a rejected company-row
 * update. Committed only when EVERY field of the requested mutation reads back
 * with its intended value; conclusively not committed only when a change was
 * requested and every field still reads its previous value; anything else
 * (re-read failure, company gone, a concurrent change) is unknown.
 */
async function classifyCompanyUpdate(before: companiesRepo.CompanyRow, data: CompanyPatch): Promise<UpdateOutcome> {
  let after: companiesRepo.CompanyRow | undefined;
  try {
    after = await companiesRepo.findById(before.id);
  } catch (err) {
    logger.error({ error: sanitizeStorageError(err), companyId: before.id }, "Branding: company row could not be re-read — update outcome unknown");
    return { kind: "unknown" };
  }
  if (!after) return { kind: "unknown" };
  const row = after as unknown as Record<string, unknown>;
  const previous = before as unknown as Record<string, unknown>;
  const intended = data as Record<string, unknown>;
  const fields = Object.keys(intended).filter((k) => !UNTRACKED_FIELDS.has(k));
  if (fields.every((k) => same(row[k], intended[k]))) return { kind: "committed", row: after };
  const changeRequested = fields.some((k) => !same(previous[k], intended[k]));
  if (changeRequested && fields.every((k) => same(row[k], previous[k]))) return { kind: "not_committed" };
  return { kind: "unknown" };
}

/**
 * B25 Correction 4 / 5 — the company-row write of a branding mutation. A
 * database error here carries SQL text, parameters and possibly a provider
 * cause; it is reduced to its sanitized shape for the log and never reaches
 * the route. A rejected statement may still have committed, so the durable row
 * decides: committed → returned as the result; not committed → the fixed
 * "nothing was changed" 503; unknown → the fixed refresh-before-retry 503.
 */
async function updateCompanyRow(before: companiesRepo.CompanyRow, data: CompanyPatch, action: string): Promise<companiesRepo.CompanyRow | undefined> {
  const companyId = before.id;
  try {
    return await companiesRepo.update(companyId, data);
  } catch (err) {
    logger.error({ error: sanitizeStorageError(err), companyId, action }, "Branding: company row update statement rejected — resolving the durable outcome");
    const outcome = await classifyCompanyUpdate(before, data);
    if (outcome.kind === "committed") {
      logger.warn({ companyId, action }, "Branding: company row update had committed although its response was lost — resolved as committed");
      return outcome.row;
    }
    if (outcome.kind === "not_committed") {
      logger.warn({ companyId, action }, "Branding: company row update did not commit (branding unchanged)");
      throw updateFailed();
    }
    logger.error({ companyId, action }, "Branding: company row update outcome could not be confirmed — nothing deleted");
    throw updateUnconfirmed();
  }
}

function safeColorsMeta(c: companiesRepo.CompanyRow) {
  return { primaryColor: c.brandPrimaryColor, sidebarColor: c.brandSidebarColor, defaultTheme: c.brandDefaultTheme, logo: c.brandLogoKey != null };
}

export async function updateBranding(req: Request, companyId: number, input: unknown): Promise<ResolvedBranding> {
  const patch = validateBrandingInput(input);
  const before = await loadCompany(companyId);
  const updated = await updateCompanyRow(before, { ...patch, updatedAt: new Date() }, "branding.update");
  if (!updated) throw new AppError(404, "Organization not found");
  await writeAudit(req, {
    action: "branding.update",
    companyId,
    entityType: "company",
    entityId: companyId,
    metadata: { before: safeColorsMeta(before), after: safeColorsMeta(updated), fields: Object.keys(patch) },
  });
  return resolveBranding(updated);
}

/**
 * Replace the managed logo. Order: validate → store NEW object → update row →
 * delete OLD object (best effort). A storage failure before the row update
 * leaves the row (and the old object) untouched and answers 503.
 */
export async function uploadLogo(req: Request, companyId: number, bytes: Buffer | undefined, declaredType: string | undefined): Promise<ResolvedBranding> {
  const before = await loadCompany(companyId);
  const logo = await validateLogoUpload(bytes, declaredType);
  if (!logoStorageAvailable()) throw storageUnavailable();
  // Batch 25: the bytes go through the object-storage boundary; the returned
  // key is the tenant-scoped reference (and the public route's random id).
  const key = await putLogo(companyId, logo.buffer, logo.contentType, logo.extension);
  let updated: companiesRepo.CompanyRow | undefined;
  try {
    updated = await updateCompanyRow(before, { brandLogoKey: key, brandLogoContentType: logo.contentType, updatedAt: new Date() }, "branding.logo.replace");
  } catch (err) {
    if (err instanceof AppError && err.code === "BRANDING_UPDATE_FAILED") {
      // The row conclusively did not change: do not leave the fresh object behind (tombstone first, bytes by the durable delete path).
      await deleteLogo(companyId, key).catch((cleanupErr) => logger.warn({ error: sanitizeStorageError(cleanupErr), companyId }, "Branding: new logo object could not be tombstoned after the row update failed"));
    } else {
      // Outcome unknown (B25 Correction 5): the row may already reference the new
      // object, so it is NEVER deleted here; it stays represented by its active
      // inventory row and, if the row never changed, the live-reference orphan
      // sweep retires it after the grace window.
      logger.warn({ companyId }, "Branding: logo replacement outcome unconfirmed — new object retained in the inventory");
    }
    throw err;
  }
  if (!updated) {
    await deleteLogo(companyId, key).catch(() => undefined);
    throw new AppError(404, "Organization not found");
  }
  if (before.brandLogoKey && before.brandLogoKey !== key && keyBelongsTo(companyId, before.brandLogoKey)) {
    // Tombstone-first: the previous id stops resolving immediately even if the
    // physical delete has to be retried later.
    await deleteLogo(companyId, before.brandLogoKey).catch((err) => logger.warn({ error: sanitizeStorageError(err), companyId }, "Branding: previous logo object could not be deleted"));
  }
  await writeAudit(req, {
    action: "branding.logo.replace",
    companyId,
    entityType: "company",
    entityId: companyId,
    metadata: {
      replaced: before.brandLogoKey != null,
      contentType: logo.contentType,
      bytes: logo.buffer.length,
      width: logo.width,
      height: logo.height,
      source: { mime: logo.sourceMime, bytes: logo.sourceBytes, width: logo.sourceWidth, height: logo.sourceHeight },
    },
  });
  return resolveBranding(updated);
}

/** Remove the managed logo (and clear the legacy logo_url so the fallback is honest). */
export async function removeLogo(req: Request, companyId: number): Promise<ResolvedBranding> {
  const before = await loadCompany(companyId);
  if (!before.brandLogoKey && !before.logoUrl) return resolveBranding(before);
  const updated = await updateCompanyRow(before, { brandLogoKey: null, brandLogoContentType: null, logoUrl: null, updatedAt: new Date() }, "branding.logo.remove");
  if (!updated) throw new AppError(404, "Organization not found");
  if (before.brandLogoKey && keyBelongsTo(companyId, before.brandLogoKey)) {
    await deleteLogo(companyId, before.brandLogoKey).catch((err) => logger.warn({ error: sanitizeStorageError(err), companyId }, "Branding: logo object could not be deleted after removal"));
  }
  await writeAudit(req, {
    action: "branding.logo.remove",
    companyId,
    entityType: "company",
    entityId: companyId,
    metadata: { hadManagedLogo: before.brandLogoKey != null, hadLegacyLogoUrl: before.logoUrl != null },
  });
  return resolveBranding(updated);
}

/** Reset every branding field (colors, theme, managed + legacy logo) to the platform default. */
export async function resetBranding(req: Request, companyId: number): Promise<ResolvedBranding> {
  const before = await loadCompany(companyId);
  const updated = await updateCompanyRow(
    before,
    {
      brandPrimaryColor: null,
      brandSidebarColor: null,
      brandDefaultTheme: null,
      brandLogoKey: null,
      brandLogoContentType: null,
      logoUrl: null,
      updatedAt: new Date(),
    },
    "branding.reset",
  );
  if (!updated) throw new AppError(404, "Organization not found");
  if (before.brandLogoKey && keyBelongsTo(companyId, before.brandLogoKey)) {
    await deleteLogo(companyId, before.brandLogoKey).catch((err) => logger.warn({ error: sanitizeStorageError(err), companyId }, "Branding: logo object could not be deleted after reset"));
  }
  await writeAudit(req, {
    action: "branding.reset",
    companyId,
    entityType: "company",
    entityId: companyId,
    metadata: { before: safeColorsMeta(before), hadLegacyLogoUrl: before.logoUrl != null },
  });
  return resolveBranding(updated);
}

export interface LogoBytes {
  buffer: Buffer;
  contentType: string;
  etag: string;
}

/** The managed logo of a company as bytes (null when none / object missing). */
export async function readLogo(companyId: number): Promise<LogoBytes | null> {
  const company = await companiesRepo.findById(companyId);
  if (!company?.brandLogoKey || !keyBelongsTo(companyId, company.brandLogoKey)) return null;
  const stored = await getLogo(companyId, company.brandLogoKey);
  if (!stored) return null;
  return { buffer: stored.buffer, contentType: company.brandLogoContentType ?? stored.contentType, etag: `"${company.brandLogoKey.split("/").pop()}"` };
}

/** Resolve the public logo route (`/branding/logos/:companyId/:id`) to bytes; the id must match the CURRENT key exactly. */
export async function readLogoById(companyId: number, id: string): Promise<LogoBytes | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const company = await companiesRepo.findById(companyId);
  if (!company?.brandLogoKey) return null;
  const expectedPrefix = `branding/${companyId}/${id}.`;
  if (!company.brandLogoKey.startsWith(expectedPrefix)) return null;
  return readLogo(companyId);
}
