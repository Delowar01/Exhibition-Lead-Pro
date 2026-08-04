import fs from "node:fs";
import { Client } from "pg";
import { API_BASE, STATE_FILE, type SeedState } from "./fixtures/seed-values";

async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;
  let state: SeedState;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return;
  }

  // Delete the seeded scan row we inserted directly (contact DELETE only
  // soft-deletes the contact; the scan row we added is cleaned up here).
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && state.seededScanId != null) {
    const pg = new Client({ connectionString: dbUrl });
    try {
      await pg.connect();
      await pg.query("DELETE FROM scans WHERE id = $1", [state.seededScanId]);
    } catch {
      /* best-effort */
    } finally {
      await pg.end().catch(() => undefined);
    }
  }

  // Soft-delete the seeded contact via the API (that is the supported path).
  if (state.token && state.contact?.id) {
    try {
      await fetch(`${API_BASE}/contacts/${state.contact.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${state.token}` },
      });
    } catch {
      /* best-effort */
    }
  }

  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

export default globalTeardown;
