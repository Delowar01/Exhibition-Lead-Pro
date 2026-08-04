/**
 * Deterministic, unique seed values shared by global setup, tests, and teardown.
 * A single run-scoped token keeps parallel/re-runs from colliding while staying
 * greppable in the UI. The auth + seeded-ids handoff is written to
 * e2e/.auth/state.json by global-setup and read back by the tests.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RUN_TAG = process.env.E2E_RUN_TAG || `QARUN${Date.now().toString(36)}`;

export const API_BASE = process.env.E2E_API_BASE || "http://localhost:80/api";

export const ADMIN = {
  email: "admin@techcorp.com",
  password: "Admin123!",
};

export const STATE_DIR = path.join(__dirname, "..", ".auth");
export const STATE_FILE = path.join(STATE_DIR, "state.json");

// Deterministic capture-detail values seeded directly into the scans table so
// the Timeline capture-detail regression (Batch D) has no AI dependency.
export const CAPTURE = {
  captureSource: "qr" as const,
  latitude: 25.19735,
  longitude: 55.27963,
  gpsAccuracy: 12,
  notes: `${RUN_TAG} capture notes — met at the DWTC booth`,
  aiSummary: `${RUN_TAG} AI summary — strong intent, follow up within 48h`,
  imageUrl: "e2e/seeded/qr-card.png",
  // extractedData is stored as JSON text; the web parses it into OCR fields.
  extractedData: {
    firstName: "Zephyr",
    lastName: "Quill",
    jobTitle: "Head of Partnerships",
    company: "Meridian Labs",
    email: `zephyr.quill.${RUN_TAG}@meridian.test`,
    mobile: "+971500001122",
  },
};

export interface SeededContact {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  jobTitle: string;
  mobile: string;
  counts: {
    call: number;
    email: number;
    whatsapp: number;
    meeting: number;
    task: number;
    follow_up: number;
    capture: number;
  };
  searchTerms: {
    call: string;
    task: string;
  };
}

export interface SeedState {
  runTag: string;
  token: string;
  refreshToken: string | null;
  user: { id: number; companyId: number; email: string; name?: string };
  contact: SeededContact;
  // A second contact created with a bad id-fallback is not needed; unknown-id
  // behavior is observed against a large non-existent id.
  seededScanId: number | null;
  capture: typeof CAPTURE;
}
