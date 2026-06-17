import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import companiesRouter from "./companies.js";
import usersRouter from "./users.js";
import contactsRouter from "./contacts.js";
import leadsRouter from "./leads.js";
import eventsRouter from "./events.js";
import scansRouter from "./scans.js";
import subscriptionsRouter from "./subscriptions.js";
import platformRouter from "./platform.js";
import reportsRouter from "./reports.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(companiesRouter);
router.use(usersRouter);
router.use(contactsRouter);
router.use(leadsRouter);
router.use(eventsRouter);
router.use(scansRouter);
router.use(subscriptionsRouter);
router.use(platformRouter);
router.use(reportsRouter);

export default router;
