import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { validateBody } from "../middlewares/validate.js";
import { SearchContactsBody, CreateSavedSearchBody, UpdateSavedSearchBody } from "@workspace/api-zod";
import * as search from "../services/search.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards. `requireTenantUser` also fences platform_owner
// out of tenant CRM (search is tenant data). `/search/contacts` is a READ, so it
// is NOT gated by blockReadOnlyMutations (read-only/cancelled tenants may still
// search). Saved/recent mutations ARE write operations and get the block.
for (const base of ["/search", "/saved-searches", "/recent-searches"]) {
  router.use(base, requireTenantUser);
}
router.use("/saved-searches", blockReadOnlyMutations);
router.use("/recent-searches", blockReadOnlyMutations);

// POST /search/contacts — advanced multi-condition search (read; records recent)
router.post("/search/contacts", validateBody(SearchContactsBody), async (req: AuthRequest, res) => {
  res.json(await search.searchContacts(req.user!, req.body ?? {}));
});

// ── Saved searches (filters + views), per-user
router.get("/saved-searches", async (req: AuthRequest, res) => {
  res.json(await search.listSaved(req.user!, { entityType: req.query.entityType as string | undefined, kind: req.query.kind as string | undefined }));
});
router.post("/saved-searches", validateBody(CreateSavedSearchBody), async (req: AuthRequest, res) => {
  res.status(201).json(await search.createSaved(req.user!, req.body ?? {}));
});
router.patch("/saved-searches/:id", validateBody(UpdateSavedSearchBody), async (req: AuthRequest, res) => {
  res.json(await search.updateSaved(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});
router.delete("/saved-searches/:id", async (req: AuthRequest, res) => {
  res.json(await search.deleteSaved(req.user!, parseInt(String(req.params.id))));
});

// ── Recent searches, per-user
router.get("/recent-searches", async (req: AuthRequest, res) => {
  res.json(await search.listRecent(req.user!, (req.query.entityType as string | undefined) ?? "contacts"));
});
router.delete("/recent-searches", async (req: AuthRequest, res) => {
  res.json(await search.clearRecent(req.user!, (req.query.entityType as string | undefined) ?? "contacts"));
});

export default router;
