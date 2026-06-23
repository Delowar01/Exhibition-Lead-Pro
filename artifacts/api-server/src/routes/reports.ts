import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";
import * as reports from "../services/reports.service.js";

const router = Router();
router.use(requireAuth);

// GET /reports/admin-dashboard
router.get("/reports/admin-dashboard", async (req: AuthRequest, res) => {
  res.json(await reports.getAdminDashboard(req.user!));
});

// GET /reports/leads-by-event
router.get("/reports/leads-by-event", async (req: AuthRequest, res) => {
  res.json(await reports.getLeadsByEvent(req.user!));
});

// GET /reports/team-performance
router.get("/reports/team-performance", async (req: AuthRequest, res) => {
  res.json(await reports.getTeamPerformance(req.user!));
});

// GET /reports/scan-activity
router.get("/reports/scan-activity", async (req: AuthRequest, res) => {
  res.json(await reports.getScanActivity(req.user!));
});

// GET /reports/lead-intelligence
router.get("/reports/lead-intelligence", async (req: AuthRequest, res) => {
  res.json(await reports.getLeadIntelligence(req.user!));
});

// GET /reports/mobile-dashboard
router.get("/reports/mobile-dashboard", async (req: AuthRequest, res) => {
  res.json(await reports.getMobileDashboard(req.user!));
});

// GET /reports/event?eventId= — full per-event report with optional filters
router.get("/reports/event", async (req: AuthRequest, res) => {
  res.json(await reports.getEventReport(req.user!, req.query as reports.EventReportParams));
});

// GET /reports/team-member?eventId=&userId= — per-member performance for one event
router.get("/reports/team-member", async (req: AuthRequest, res) => {
  res.json(await reports.getTeamMemberReport(req.user!, req.query as reports.TeamMemberReportParams));
});

export default router;
