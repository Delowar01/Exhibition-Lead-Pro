import { Router } from "express";
import { requireAuth, requireTenantUser, blockReadOnlyMutations, requirePermission, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateDepartmentBody, UpdateDepartmentBody } from "@workspace/api-zod";
import * as departments from "../services/departments.service.js";

const router = Router();
router.use(requireAuth);
router.use("/departments", requireTenantUser);
router.use("/departments", blockReadOnlyMutations);
router.use("/departments", auditMutations("departments"));

// GET /departments
router.get("/departments", requirePermission("departments", "view"), async (req: AuthRequest, res) => {
  res.json(await departments.listDepartments(req.user!, req.query as departments.ListDepartmentsParams));
});

// POST /departments
router.post("/departments", requirePermission("departments", "create"), validateBody(CreateDepartmentBody), async (req: AuthRequest, res) => {
  res.status(201).json(await departments.createDepartment(req.user!, req.body ?? {}));
});

// GET /departments/:id
router.get("/departments/:id", requirePermission("departments", "view"), async (req: AuthRequest, res) => {
  res.json(await departments.getDepartment(req.user!, parseInt(String(req.params.id))));
});

// PATCH /departments/:id
router.patch("/departments/:id", requirePermission("departments", "edit"), validateBody(UpdateDepartmentBody), async (req: AuthRequest, res) => {
  res.json(await departments.updateDepartment(req.user!, parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /departments/:id
router.delete("/departments/:id", requirePermission("departments", "delete"), async (req: AuthRequest, res) => {
  res.json(await departments.deleteDepartment(req.user!, parseInt(String(req.params.id))));
});

// POST /departments/:id/archive
router.post("/departments/:id/archive", requirePermission("departments", "edit"), async (req: AuthRequest, res) => {
  res.json(await departments.archiveDepartment(req.user!, parseInt(String(req.params.id))));
});

// POST /departments/:id/restore
router.post("/departments/:id/restore", requirePermission("departments", "edit"), async (req: AuthRequest, res) => {
  res.json(await departments.restoreDepartment(req.user!, parseInt(String(req.params.id))));
});

export default router;
