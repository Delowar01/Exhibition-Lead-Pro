import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as profile from "../services/profile.service.js";

const router = Router();
router.use(requireAuth);
router.use("/profile", auditMutations("profile"));

// GET /profile — the authenticated user's own profile.
router.get("/profile", async (req: AuthRequest, res) => {
  res.json(await profile.getProfile(req.user!));
});

// PATCH /profile — self-service update (name/phone/avatar/language/timezone).
router.patch("/profile", async (req: AuthRequest, res) => {
  res.json(await profile.updateProfile(req.user!, req.body ?? {}));
});

// GET /profile/activity — sessions, login history, trusted devices.
router.get("/profile/activity", async (req: AuthRequest, res) => {
  res.json(await profile.getActivity(req.user!, req.user!.sessionId ?? null));
});

export default router;
