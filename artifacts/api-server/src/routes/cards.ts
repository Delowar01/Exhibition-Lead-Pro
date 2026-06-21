import { Router } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { businessCardsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";

const router = Router();

// Editable card fields the client may set (avatar is intentionally excluded —
// it is always sourced from the user's account).
const EDITABLE_FIELDS = [
  "fullName",
  "designation",
  "companyName",
  "email",
  "primaryPhone",
  "altPhone",
  "officeAddress",
  "website",
  "linkedin",
  "facebook",
  "instagram",
  "twitter",
  "youtube",
] as const;

function generateToken(): string {
  // URL-safe, unguessable token for the public card URL.
  return randomBytes(16).toString("base64url");
}

function pickEditable(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    const v = body[field];
    if (v === null || typeof v === "string") patch[field] = v;
  }
  if (body.fieldVisibility && typeof body.fieldVisibility === "object") {
    patch.fieldVisibility = body.fieldVisibility;
  }
  if (typeof body.templateId === "string" && body.templateId.length > 0) {
    patch.templateId = body.templateId;
  }
  if (typeof body.isPublished === "boolean") {
    patch.isPublished = body.isPublished;
  }
  return patch;
}

function formatCard(card: typeof businessCardsTable.$inferSelect, avatarUrl: string | null) {
  return { ...card, avatarUrl };
}

// ── AUTHENTICATED ─────────────────────────────────────────────────────────
// NOTE: the PUBLIC GET /cards/public/:token route lives in cards-public.ts and is
// mounted BEFORE the first auth-guarded router. It cannot live here: every authed
// sub-router has a path-less requireAuth that would 401 the public request first.
router.use(requireAuth);
router.use("/cards", blockReadOnlyMutations);
router.use("/cards", auditMutations("cards"));

// GET /cards/me — the signed-in user's own card
router.get("/cards/me", async (req: AuthRequest, res) => {
  try {
    const [card] = await db.select().from(businessCardsTable).where(eq(businessCardsTable.userId, req.user!.id)).limit(1);
    if (!card) {
      res.status(404).json({ error: "No card yet" });
      return;
    }
    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.id))
      .limit(1);
    res.json(formatCard(card, owner?.avatarUrl ?? null));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /cards/me — create or update the signed-in user's own card
router.put("/cards/me", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    // Tenant invariant: a card must belong to a company (platform_owner has no
    // tenant and therefore no shareable company card).
    if (companyId == null) {
      res.status(400).json({ error: "A company is required to create a card" });
      return;
    }
    const patch = pickEditable(req.body ?? {});
    const [existing] = await db
      .select()
      .from(businessCardsTable)
      .where(eq(businessCardsTable.userId, req.user!.id))
      .limit(1);

    let card: typeof businessCardsTable.$inferSelect;
    if (existing) {
      [card] = await db
        .update(businessCardsTable)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(businessCardsTable.userId, req.user!.id))
        .returning();
    } else {
      [card] = await db
        .insert(businessCardsTable)
        .values({ ...patch, userId: req.user!.id, companyId, publicToken: generateToken() })
        .returning();
    }

    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.id))
      .limit(1);
    res.json(formatCard(card, owner?.avatarUrl ?? null));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
