import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as ai from "../services/ai.service.js";

const router = Router();
router.use(requireAuth);

// Tenant-scoped AI endpoints. platform_owner (no company) is blocked by
// requireTenantUser (403) — the platform operator uses /ai/platform/usage instead.
// Guards are path-scoped to each sub-path (NOT "/ai"), because /ai/platform/usage
// has DIFFERENT access rules and a "/ai" prefix guard would also match it.
router.use("/ai/settings", requireTenantUser);
router.use("/ai/settings", blockReadOnlyMutations);
router.use("/ai/settings", auditMutations("ai"));
router.use("/ai/usage", requireTenantUser);
router.use("/ai/health", requireTenantUser);
// Platform-wide AI visibility — platform_owner only.
router.use("/ai/platform", requireRole("platform_owner"));

// GET /ai/settings — effective settings for the caller's tenant
router.get("/ai/settings", async (req: AuthRequest, res) => {
  res.json(await ai.getSettings(req.user!));
});

// PATCH /ai/settings — primary_admin only (validated inside the service)
router.patch("/ai/settings", requireRole("primary_admin"), async (req: AuthRequest, res) => {
  res.json(await ai.updateSettings(req.user!, req.body ?? {}));
});

// GET /ai/usage — usage & estimated cost for the caller's tenant
router.get("/ai/usage", async (req: AuthRequest, res) => {
  res.json(await ai.getUsage(req.user!, req.query as Record<string, unknown>));
});

// GET /ai/health — provider configuration & recent reliability
router.get("/ai/health", async (req: AuthRequest, res) => {
  res.json(await ai.getHealth(req.user!));
});

// GET /ai/platform/usage — platform-wide usage across all tenants
router.get("/ai/platform/usage", async (req: AuthRequest, res) => {
  res.json(await ai.getPlatformUsage(req.query as Record<string, unknown>));
});

export default router;
