import { Router } from "express";
import { db } from "@workspace/db";
import { scansTable, companiesTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/requireAuth.js";

const router = Router();
router.use(requireAuth);

// Simulated OCR extraction (in production, this would call OpenAI/Google Vision)
function simulateOcr(imageData: string): Record<string, string | null> {
  // Return mock extracted data for demo
  const demos = [
    { firstName: "Sarah", lastName: "Chen", jobTitle: "VP of Sales", company: "TechCorp Inc", email: "s.chen@techcorp.com", mobile: "+1 415 555 0123", website: "techcorp.com", linkedin: "linkedin.com/in/sarahchen", address: "350 Market St, San Francisco, CA" },
    { firstName: "James", lastName: "Al-Rashid", jobTitle: "CTO", company: "Nexus Systems", email: "james@nexussys.io", mobile: "+971 50 123 4567", website: "nexussys.io", linkedin: null, address: "Dubai Internet City, UAE" },
    { firstName: "Maria", lastName: "García", jobTitle: "Business Development Manager", company: "Innovatech", email: "m.garcia@innovatech.es", mobile: "+34 612 345 678", website: null, linkedin: "linkedin.com/in/mariagarcia", address: "Calle Gran Vía 45, Madrid" },
  ];
  return demos[Math.floor(Math.random() * demos.length)];
}

// GET /scans
router.get("/scans", async (req: AuthRequest, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, parseInt(limit));
    const offset = (pageNum - 1) * limitNum;
    const companyId = req.user!.companyId;

    const conditions = companyId ? [eq(scansTable.companyId, companyId)] : [];
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ total }] = await db.select({ total: count() }).from(scansTable).where(whereClause);
    const scans = await db.select().from(scansTable).where(whereClause).limit(limitNum).offset(offset).orderBy(scansTable.createdAt);
    const formatted = scans.map(s => ({ ...s, extractedData: s.extractedData ? JSON.parse(s.extractedData) : null }));
    res.json({ scans: formatted, total });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /scans
router.post("/scans", async (req: AuthRequest, res) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) { res.status(400).json({ error: "No company context" }); return; }
    const { imageData, eventId } = req.body;
    if (!imageData) { res.status(400).json({ error: "imageData required" }); return; }

    // Increment company scans used
    await db.update(companiesTable).set({ scansUsed: eq(companiesTable.id, companyId) as unknown as number }).where(eq(companiesTable.id, companyId));

    // Create scan record
    const [scan] = await db.insert(scansTable).values({ companyId, userId: req.user!.id, status: "processing", imageUrl: null, extractedData: null }).returning();

    // Simulate OCR processing
    const extracted = simulateOcr(imageData);
    const [updated] = await db.update(scansTable).set({ status: "completed", extractedData: JSON.stringify(extracted) }).where(eq(scansTable.id, scan.id)).returning();

    res.status(201).json({ ...updated, extractedData: extracted });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /scans/:id
router.get("/scans/:id", async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params.id);
    const [scan] = await db.select().from(scansTable).where(eq(scansTable.id, id)).limit(1);
    if (!scan) { res.status(404).json({ error: "Scan not found" }); return; }
    res.json({ ...scan, extractedData: scan.extractedData ? JSON.parse(scan.extractedData) : null });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
