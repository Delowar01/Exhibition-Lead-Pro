import { Router } from "express";
import { UpdatePlatformAiProvidersBody } from "@workspace/api-zod";
import { requireAuth, requireRole, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { getClientIp } from "../lib/security.js";
import * as platformAi from "../services/platform-ai.service.js";

// Platform Owner → Settings → AI Providers.
//
// Path-scoped behind the platform firewall, like every /platform router: a tenant user
// (primary_admin, admin, employee) receives 403 before anything is read, and an
// unauthenticated caller 401. The responses carry the policy, credential PRESENCE (never
// a key), platform-wide usage totals and company ids/names of pinned tenants — no tenant
// CRM record — so the Platform Owner tenant-data firewall is not widened by this module.
const router = Router();
router.use(requireAuth);
router.use("/platform/ai", requireRole("platform_owner"));

router.get("/platform/ai/providers", async (_req: AuthRequest, res) => {
  res.json(await platformAi.getStatus());
});

// The body is the COMPLETE policy plus the version it was read at. The generated schema
// checks its shape; the service validates it strictly (unknown keys, selectable models,
// existing companies), asks for confirmation where availability is reduced, and writes
// the policy and its audit row in one transaction.
router.put("/platform/ai/providers", validateBody(UpdatePlatformAiProvidersBody), async (req: AuthRequest, res) => {
  const body = req.body as { policy: unknown; expectedVersion: number; confirm?: boolean };
  const actor = { userId: req.user!.id, userName: req.user!.email, ipAddress: getClientIp(req) };
  res.json(await platformAi.updatePolicy(actor, { policy: body.policy, expectedVersion: body.expectedVersion, confirm: body.confirm === true }));
});

export default router;
