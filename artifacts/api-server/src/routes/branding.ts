import { Router, raw, type Request, type Response } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { UpdateTenantBrandingBody } from "@workspace/api-zod";
import { config } from "../config.js";
import { LOGO_MIME_TYPES } from "../lib/branding/logo.js";
import { armStorageFailureForTests } from "../lib/branding/storage.js";
import * as branding from "../services/branding.service.js";

// =============================================================================
// Batch 18 — tenant branding.
//   GET    /branding/logos/:companyId/:id   PUBLIC: the managed logo by its random
//                                           object id (an API route, never a storage
//                                           URL; the id changes on every replacement,
//                                           so it is also the cache key)
//   GET    /organization/branding           any authenticated tenant member
//   PUT    /organization/branding           organization:edit (primary_admin bypasses)
//   POST   /organization/branding/logo      organization:edit — raw image body
//   DELETE /organization/branding/logo      organization:edit
//   POST   /organization/branding/reset     organization:edit
//   GET    /organization/branding/logo      any member (the tenant's own logo bytes)
// The company is ALWAYS the authenticated user's own; platform operators use
// /companies/:id/branding (routes/companies.ts). Mounted BEFORE routes/org.ts so
// its path-less requireAuth / generic audit never see these paths.
// =============================================================================

const router = Router();

/** Raw image body (PNG/JPEG/WebP only). Larger bodies are cut at the parser (413). */
export const rawLogoBody = raw({ type: [...LOGO_MIME_TYPES], limit: "6mb" });

export function sendLogo(res: Response, logo: branding.LogoBytes | null, cache: string): void {
  if (!logo) {
    res.status(404).json({ error: "Logo not found" });
    return;
  }
  res.setHeader("Content-Type", logo.contentType);
  res.setHeader("Content-Length", String(logo.buffer.length));
  res.setHeader("Cache-Control", cache);
  res.setHeader("ETag", logo.etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(logo.buffer);
}

/** Non-production hook used by the storage-failure rollback test (memory driver only). */
function maybeArmStorageFailure(req: Request): void {
  if (config.isProduction) return;
  if (req.headers["x-branding-test-storage-fail"] === "1") armStorageFailureForTests();
}

// ── public managed-logo route (no auth; unguessable id) ────────────────────
router.get("/branding/logos/:companyId/:id", async (req: AuthRequest, res) => {
  const companyId = parseInt(String(req.params.companyId), 10);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(404).json({ error: "Logo not found" });
    return;
  }
  sendLogo(res, await branding.readLogoById(companyId, String(req.params.id)), "public, max-age=31536000, immutable");
});

// ── tenant self-service ─────────────────────────────────────────────────────
router.use("/organization/branding", requireAuth, requireTenantUser, blockReadOnlyMutations);

router.get("/organization/branding", async (req: AuthRequest, res) => {
  res.json(await branding.getBranding(branding.tenantCompanyId(req.user!)));
});

router.put("/organization/branding", requirePermission("organization", "edit"), validateBody(UpdateTenantBrandingBody), async (req: AuthRequest, res) => {
  res.json(await branding.updateBranding(req, branding.tenantCompanyId(req.user!), req.body ?? {}));
});

router.post("/organization/branding/logo", requirePermission("organization", "edit"), rawLogoBody, async (req: AuthRequest, res) => {
  maybeArmStorageFailure(req);
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  res.json(await branding.uploadLogo(req, branding.tenantCompanyId(req.user!), body, req.headers["content-type"]));
});

router.delete("/organization/branding/logo", requirePermission("organization", "edit"), async (req: AuthRequest, res) => {
  res.json(await branding.removeLogo(req, branding.tenantCompanyId(req.user!)));
});

router.post("/organization/branding/reset", requirePermission("organization", "edit"), async (req: AuthRequest, res) => {
  res.json(await branding.resetBranding(req, branding.tenantCompanyId(req.user!)));
});

router.get("/organization/branding/logo", async (req: AuthRequest, res) => {
  sendLogo(res, await branding.readLogo(branding.tenantCompanyId(req.user!)), "private, max-age=300");
});

export default router;
