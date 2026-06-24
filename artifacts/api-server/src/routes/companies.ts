import { Router } from "express";
import { requireAuth, requireRole, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateCompanyBody, UpdateCompanyBody } from "@workspace/api-zod";
import * as companies from "../services/companies.service.js";

const router = Router();
router.use(requireAuth);
router.use("/companies", requireRole("platform_owner"));
router.use("/companies", blockReadOnlyMutations);
router.use("/companies", auditMutations("company"));

// GET /companies
router.get("/companies", async (req: AuthRequest, res) => {
  res.json(await companies.listCompanies(req.query as companies.ListCompaniesParams));
});

// POST /companies
router.post("/companies", validateBody(CreateCompanyBody), async (req: AuthRequest, res) => {
  res.status(201).json(await companies.createCompany(req.user!, req.body ?? {}));
});

// GET /companies/:id
router.get("/companies/:id", async (req: AuthRequest, res) => {
  res.json(await companies.getCompany(parseInt(String(req.params.id))));
});

// PATCH /companies/:id
router.patch("/companies/:id", validateBody(UpdateCompanyBody), async (req: AuthRequest, res) => {
  res.json(await companies.updateCompany(parseInt(String(req.params.id)), req.body ?? {}));
});

// DELETE /companies/:id
router.delete("/companies/:id", async (req: AuthRequest, res) => {
  res.json(await companies.deleteCompany(req.user!, parseInt(String(req.params.id))));
});

// POST /companies/:id/suspend
router.post("/companies/:id/suspend", async (req: AuthRequest, res) => {
  res.json(await companies.suspendCompany(req.user!, parseInt(String(req.params.id))));
});

// POST /companies/:id/activate
router.post("/companies/:id/activate", async (req: AuthRequest, res) => {
  res.json(await companies.activateCompany(req.user!, parseInt(String(req.params.id))));
});

export default router;
