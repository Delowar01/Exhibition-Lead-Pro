import { Router } from "express";
import { db } from "@workspace/db";
import { deviceTokensTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

// POST /push/register — upsert an Expo push token for the current user's device.
router.post("/push/register", async (req: AuthRequest, res) => {
  try {
    const { token, platform } = req.body as { token?: string; platform?: string };
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }
    await db
      .insert(deviceTokensTable)
      .values({ userId: req.user!.id, token, platform: platform ?? null })
      .onConflictDoUpdate({
        target: deviceTokensTable.token,
        set: { userId: req.user!.id, platform: platform ?? null, updatedAt: new Date() },
      });
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /push/unregister — remove a token (e.g. on logout). Scoped to the caller.
router.post("/push/unregister", async (req: AuthRequest, res) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }
    await db
      .delete(deviceTokensTable)
      .where(and(eq(deviceTokensTable.token, token), eq(deviceTokensTable.userId, req.user!.id)));
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
