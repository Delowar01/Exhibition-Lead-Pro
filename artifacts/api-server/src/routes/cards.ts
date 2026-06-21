import { Router } from "express";
import { randomBytes } from "node:crypto";
import { db, businessCardsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";

const router = Router();

type CardRow = typeof businessCardsTable.$inferSelect;

// Absolute origin for public share links. Prefer the published domain, fall
// back to the forwarded host of the current request (dev preview).
function publicBaseUrl(req: AuthRequest): string {
  const published = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (published) return `https://${published}`;
  const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0];
  const host = req.headers["host"];
  return `${proto}://${host}`;
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

function isVisible(visibility: Record<string, boolean> | null, key: string): boolean {
  // Default visible: only an explicit `false` hides a field.
  return (visibility ?? {})[key] !== false;
}

function formatOwnerCard(card: CardRow, base: string, avatarUrl: string | null, accountName: string | null) {
  return {
    ...card,
    avatarUrl,
    accountName,
    publicUrl: `${base}/c/${card.publicToken}`,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PUBLIC — unauthenticated. Declared first; carries NO auth guard.
// ---------------------------------------------------------------------------
router.get("/cards/public/:token", async (req: AuthRequest, res) => {
  try {
    const token = String(req.params.token);
    const [card] = await db.select().from(businessCardsTable).where(eq(businessCardsTable.publicToken, token)).limit(1);
    if (!card || !card.isPublished) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, card.userId))
      .limit(1);

    const vis = card.fieldVisibility;
    const pick = (key: string, value: string | null) => (isVisible(vis, key) ? value : null);

    res.json({
      fullName: card.fullName,
      designation: card.designation,
      companyName: card.companyName,
      email: pick("email", card.email),
      primaryPhone: pick("primaryPhone", card.primaryPhone),
      alternatePhone: pick("alternatePhone", card.alternatePhone),
      officeAddress: pick("officeAddress", card.officeAddress),
      website: pick("website", card.website),
      linkedin: pick("linkedin", card.linkedin),
      facebook: pick("facebook", card.facebook),
      instagram: pick("instagram", card.instagram),
      twitter: pick("twitter", card.twitter),
      youtube: pick("youtube", card.youtube),
      avatarUrl: owner?.avatarUrl ?? null,
      templateId: card.templateId,
      publicUrl: `${publicBaseUrl(req)}/c/${card.publicToken}`,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// AUTHENTICATED — path-scoped guards so they never leak onto the public route
// above or onto unrelated modules sharing the parent router.
// ---------------------------------------------------------------------------
router.use("/cards/me", requireAuth);
router.use("/cards/me", blockReadOnlyMutations);
router.use("/cards/me", auditMutations("cards"));

// GET /cards/me
router.get("/cards/me", async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const [card] = await db.select().from(businessCardsTable).where(eq(businessCardsTable.userId, userId)).limit(1);
    if (!card) {
      res.status(404).json({ error: "No card yet" });
      return;
    }
    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    res.json(formatOwnerCard(card, publicBaseUrl(req), owner?.avatarUrl ?? null, owner?.name ?? null));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /cards/me — upsert (creates on first save, updates thereafter)
router.put("/cards/me", async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};

    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (!fullName) {
      res.status(400).json({ error: "Full name is required" });
      return;
    }

    const str = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s.length > 0 ? s : null;
    };

    let fieldVisibility: Record<string, boolean> = {};
    if (body.fieldVisibility && typeof body.fieldVisibility === "object" && !Array.isArray(body.fieldVisibility)) {
      for (const [k, v] of Object.entries(body.fieldVisibility as Record<string, unknown>)) {
        if (typeof v === "boolean") fieldVisibility[k] = v;
      }
    }

    const values = {
      fullName,
      designation: str(body.designation),
      companyName: str(body.companyName),
      email: str(body.email),
      primaryPhone: str(body.primaryPhone),
      alternatePhone: str(body.alternatePhone),
      officeAddress: str(body.officeAddress),
      website: str(body.website),
      linkedin: str(body.linkedin),
      facebook: str(body.facebook),
      instagram: str(body.instagram),
      twitter: str(body.twitter),
      youtube: str(body.youtube),
      fieldVisibility,
      templateId: str(body.templateId) ?? "classic",
      isPublished: typeof body.isPublished === "boolean" ? body.isPublished : true,
      updatedAt: new Date(),
    };

    const [existing] = await db
      .select()
      .from(businessCardsTable)
      .where(eq(businessCardsTable.userId, userId))
      .limit(1);

    let card: CardRow;
    if (existing) {
      [card] = await db
        .update(businessCardsTable)
        .set(values)
        .where(eq(businessCardsTable.userId, userId))
        .returning();
    } else {
      [card] = await db
        .insert(businessCardsTable)
        .values({
          ...values,
          userId,
          companyId: req.user!.companyId ?? null,
          publicToken: newToken(),
        })
        .returning();
    }

    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    res.json(formatOwnerCard(card, publicBaseUrl(req), owner?.avatarUrl ?? null, owner?.name ?? null));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
