import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { UpdateNotificationPreferenceBody } from "@workspace/api-zod";
import * as notifications from "../services/notifications.service.js";
import { parseListQuery } from "../lib/list-query.js";

const router = Router();
router.use(requireAuth);

// GET /notifications?page&pageSize|limit&unreadOnly — the caller's own feed.
// Standard list contract; defaults to the 50 most-recent (cap 200) to preserve behavior.
router.get("/notifications", async (req: AuthRequest, res) => {
  const lq = parseListQuery(req.query, { defaultPageSize: 50, maxPageSize: 200 });
  const unreadOnly = req.query.unreadOnly === "true";
  res.json(await notifications.listNotifications(req.user!, { limit: lq.limit, offset: lq.offset, unreadOnly }));
});

// GET /notifications/unread-count — registered before /:id-style routes (none here,
// but keep static paths first by convention).
router.get("/notifications/unread-count", async (req: AuthRequest, res) => {
  res.json(await notifications.getUnreadCount(req.user!));
});

// GET /notifications/preferences
router.get("/notifications/preferences", async (req: AuthRequest, res) => {
  res.json(await notifications.getPreferences(req.user!));
});

// PATCH /notifications/preferences — upsert one category preference.
router.patch("/notifications/preferences", validateBody(UpdateNotificationPreferenceBody), async (req: AuthRequest, res) => {
  res.json(await notifications.updatePreference(req.user!, req.body ?? {}));
});

// POST /notifications/read-all
router.post("/notifications/read-all", async (req: AuthRequest, res) => {
  res.json(await notifications.markAllRead(req.user!));
});

// POST /notifications/:id/read
router.post("/notifications/:id/read", async (req: AuthRequest, res) => {
  res.json(await notifications.markRead(req.user!, parseInt(String(req.params.id))));
});

// DELETE /notifications/:id
router.delete("/notifications/:id", async (req: AuthRequest, res) => {
  res.json(await notifications.deleteNotification(req.user!, parseInt(String(req.params.id))));
});

export default router;
