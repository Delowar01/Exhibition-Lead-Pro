import { Router } from "express";
import { requireAuth, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import * as invitations from "../services/invitations.service.js";

const router = Router();

// --- Public, token-based routes (no auth). Registered first so the authed
// router.use(requireAuth) below does not gate them. ---

// GET /invitations/token/:token — fetch invitation details for the accept screen.
router.get("/invitations/token/:token", async (req: AuthRequest, res) => {
  res.json(await invitations.getInvitationByToken(req.params.token));
});

// POST /invitations/accept — create the user + assign roles.
router.post("/invitations/accept", async (req: AuthRequest, res) => {
  res.json(await invitations.acceptInvitation(req.body ?? {}));
});

// POST /invitations/reject — decline an invitation.
router.post("/invitations/reject", async (req: AuthRequest, res) => {
  res.json(await invitations.rejectInvitation(req.body ?? {}));
});

// --- Authed management routes. Path-scoped audit so it never fires on other modules. ---
router.use("/invitations", requireAuth, auditMutations("invitations"));

// GET /invitations — list invitations for the caller's accessible companies.
router.get("/invitations", async (req: AuthRequest, res) => {
  const companyId = req.query.companyId ? parseInt(String(req.query.companyId)) : undefined;
  res.json(await invitations.listInvitations(req.user!, companyId));
});

// POST /invitations — create + email an invitation.
router.post("/invitations", requirePermission("team", "create"), async (req: AuthRequest, res) => {
  res.status(201).json(await invitations.createInvitation(req.user!, req.body ?? {}));
});

// POST /invitations/:id/resend — re-issue token + resend email.
router.post("/invitations/:id/resend", requirePermission("team", "create"), async (req: AuthRequest, res) => {
  res.json(await invitations.resendInvitation(req.user!, parseInt(String(req.params.id))));
});

// DELETE /invitations/:id — cancel a pending invitation.
router.delete("/invitations/:id", requirePermission("team", "delete"), async (req: AuthRequest, res) => {
  res.json(await invitations.cancelInvitation(req.user!, parseInt(String(req.params.id))));
});

export default router;
