import { Router } from "express";
import { db } from "@workspace/db";
import { businessCardsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// PUBLIC (unauthenticated) digital business card lookup.
//
// This MUST be mounted before the first auth-guarded sub-router. Every authed
// sub-router (companies, users, contacts, …) registers a path-less
// `router.use(requireAuth)` that fires on EVERY request flowing through the shared
// parent router. If this route were mounted after them, an unauthenticated public
// request would be 401'd before reaching this handler.
//
// Returns only public-safe fields, honoring the owner's per-field visibility map,
// joined with the owner's avatar for the public card's initials/photo fallback.
router.get("/cards/public/:token", async (req, res) => {
  try {
    const token = String(req.params.token);
    const [card] = await db
      .select()
      .from(businessCardsTable)
      .where(eq(businessCardsTable.publicToken, token))
      .limit(1);
    if (!card || !card.isPublished) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    const [owner] = await db
      .select({ avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(eq(usersTable.id, card.userId))
      .limit(1);

    const visibility = card.fieldVisibility ?? {};
    const visible = <T>(field: string, value: T): T | null => (visibility[field] === false ? null : value);

    res.json({
      publicToken: card.publicToken,
      fullName: card.fullName,
      designation: visible("designation", card.designation),
      companyName: visible("companyName", card.companyName),
      email: visible("email", card.email),
      primaryPhone: visible("primaryPhone", card.primaryPhone),
      altPhone: visible("altPhone", card.altPhone),
      officeAddress: visible("officeAddress", card.officeAddress),
      website: visible("website", card.website),
      linkedin: visible("linkedin", card.linkedin),
      facebook: visible("facebook", card.facebook),
      instagram: visible("instagram", card.instagram),
      twitter: visible("twitter", card.twitter),
      youtube: visible("youtube", card.youtube),
      avatarUrl: owner?.avatarUrl ?? null,
      templateId: card.templateId,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
