import { Router } from "express";
import { requireAuth, requireRole, blockReadOnlyMutations, type AuthRequest } from "../middlewares/requireAuth.js";
import { auditMutations } from "../lib/audit.js";
import { validateBody } from "../middlewares/validate.js";
import { CreateCompanyBody, UpdateCompanyBody, UpdateCompanyBrandingBody } from "@workspace/api-zod";
import * as companies from "../services/companies.service.js";
import * as branding from "../services/branding.service.js";
import { rawLogoBody, sendLogo } from "./branding.js";

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

// ── Tenant branding by explicit company id (Batch 18; platform operator only).
// Same service as the tenant self-service routes, same validation, same audit.
const companyIdParam = (req: AuthRequest) => parseInt(String(req.params.id), 10);

router.get("/companies/:id/branding", async (req: AuthRequest, res) => {
  res.json(await branding.getBranding(companyIdParam(req)));
});

router.put("/companies/:id/branding", validateBody(UpdateCompanyBrandingBody), async (req: AuthRequest, res) => {
  res.json(await branding.updateBranding(req, companyIdParam(req), req.body ?? {}));
});

router.post("/companies/:id/branding/logo", rawLogoBody, async (req: AuthRequest, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  res.json(await branding.uploadLogo(req, companyIdParam(req), body, req.headers["content-type"]));
});

router.delete("/companies/:id/branding/logo", async (req: AuthRequest, res) => {
  res.json(await branding.removeLogo(req, companyIdParam(req)));
});

router.post("/companies/:id/branding/reset", async (req: AuthRequest, res) => {
  res.json(await branding.resetBranding(req, companyIdParam(req)));
});

router.get("/companies/:id/branding/logo", async (req: AuthRequest, res) => {
  sendLogo(res, await branding.readLogo(companyIdParam(req)), "private, max-age=60");
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
