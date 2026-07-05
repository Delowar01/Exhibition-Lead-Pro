import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import {
  CreateDocumentBody,
  UpdateDocumentBody,
  AddDocumentVersionBody,
  RequestDocumentUploadUrlBody,
} from "@workspace/api-zod";
import * as documents from "../services/documents.service.js";

const router = Router();
router.use(requireAuth);
// Path-scoped terminating guards to the module base. platform_owner is blocked
// from all customer document data by requireTenantUser (403). A path-less
// router.use would leak onto every request flowing through the shared parent.
router.use("/documents", requireTenantUser);
router.use("/documents", blockReadOnlyMutations);
router.use("/documents", auditMutations("documents"));

// ── Static sub-paths BEFORE /documents/:id (Express matches in declaration order) ──

// GET /documents/categories
router.get("/documents/categories", async (_req: AuthRequest, res) => {
  res.json(documents.getCategoryCatalog());
});

// POST /documents/upload-url
router.post("/documents/upload-url", requirePermission("documents", "create"), validateBody(RequestDocumentUploadUrlBody), async (req: AuthRequest, res) => {
  res.json(await documents.createUploadUrl(req.user!, req.body ?? {}));
});

// GET /documents
router.get("/documents", async (req: AuthRequest, res) => {
  res.json(await documents.listDocuments(req.user!, req.query as documents.ListDocumentsParams));
});

// POST /documents
router.post("/documents", requirePermission("documents", "create"), validateBody(CreateDocumentBody), async (req: AuthRequest, res) => {
  res.status(201).json(await documents.createDocument(req.user!, req.body ?? {}));
});

// ── Document sub-resources (before /:id catch-all where a static suffix follows) ──

// GET /documents/:id/versions
router.get("/documents/:id/versions", async (req: AuthRequest, res) => {
  res.json(await documents.listVersions(req.user!, parseInt(String(req.params.id))));
});

// POST /documents/:id/versions
router.post("/documents/:id/versions", requirePermission("documents", "edit"), validateBody(AddDocumentVersionBody), async (req: AuthRequest, res) => {
  res.status(201).json(await documents.addVersion(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// GET /documents/:id/versions/:versionId/download
router.get("/documents/:id/versions/:versionId/download", async (req: AuthRequest, res) => {
  res.json(await documents.getDownloadUrlForVersion(req.user!, parseInt(String(req.params.id)), parseInt(String(req.params.versionId))));
});

// GET /documents/:id/download
router.get("/documents/:id/download", async (req: AuthRequest, res) => {
  res.json(await documents.getDownloadUrlForCurrent(req.user!, parseInt(String(req.params.id))));
});

// POST /documents/:id/restore
router.post("/documents/:id/restore", requirePermission("documents", "edit"), async (req: AuthRequest, res) => {
  res.json(await documents.restoreDocument(req.user!, parseInt(String(req.params.id))));
});

// GET /documents/:id
router.get("/documents/:id", async (req: AuthRequest, res) => {
  res.json(await documents.getDocument(req.user!, parseInt(String(req.params.id))));
});

// PATCH /documents/:id
router.patch("/documents/:id", requirePermission("documents", "edit"), validateBody(UpdateDocumentBody), async (req: AuthRequest, res) => {
  res.json(await documents.updateDocument(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /documents/:id
router.delete("/documents/:id", requirePermission("documents", "delete"), async (req: AuthRequest, res) => {
  res.json(await documents.deleteDocument(req.user!, parseInt(String(req.params.id))));
});

export default router;
