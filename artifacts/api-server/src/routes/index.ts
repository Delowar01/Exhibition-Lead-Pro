import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import companiesRouter from "./companies.js";
import usersRouter from "./users.js";
import contactsRouter from "./contacts.js";
import leadsRouter from "./leads.js";
import pipelineRouter from "./pipeline.js";
import tagsRouter from "./tags.js";
import eventsRouter from "./events.js";
import departmentsRouter from "./departments.js";
import teamsRouter from "./teams.js";
import scansRouter from "./scans.js";
import subscriptionsRouter from "./subscriptions.js";
import platformRouter from "./platform.js";
import reportsRouter from "./reports.js";
import analyticsRouter from "./analytics.js";
import pushRouter from "./push.js";
import followUpsRouter from "./follow_ups.js";
import meetingsRouter from "./meetings.js";
import tasksRouter from "./tasks.js";
import cardsRouter from "./cards.js";
import rbacRouter from "./rbac.js";
import orgRouter from "./org.js";
import securityRouter from "./security.js";
import profileRouter from "./profile.js";
import invitationsRouter from "./invitations.js";
import notificationsRouter from "./notifications.js";
import documentsRouter from "./documents.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// Mounted early: cards.ts has a PUBLIC route (/cards/public/:token) with no auth.
// A later-mounted router with a path-less requireAuth would otherwise 401 it
// before the request ever reaches here. Its own guards are path-scoped to
// /cards/me, so this does not leak onto other modules.
router.use(cardsRouter);
// Mounted early: invitations.ts has PUBLIC routes (/invitations/token/:token,
// /invitations/accept, /invitations/reject) with no auth. Its authed management
// guards are path-scoped to /invitations, so this does not leak onto other modules.
router.use(invitationsRouter);
router.use(notificationsRouter);
router.use(documentsRouter);
router.use(companiesRouter);
router.use(usersRouter);
router.use(rbacRouter);
router.use(orgRouter);
router.use(securityRouter);
router.use(profileRouter);
router.use(contactsRouter);
router.use(leadsRouter);
router.use(pipelineRouter);
router.use(tagsRouter);
router.use(eventsRouter);
router.use(departmentsRouter);
router.use(teamsRouter);
router.use(scansRouter);
router.use(subscriptionsRouter);
router.use(platformRouter);
router.use(reportsRouter);
router.use(analyticsRouter);
router.use(pushRouter);
router.use(followUpsRouter);
router.use(meetingsRouter);
router.use(tasksRouter);

export default router;
