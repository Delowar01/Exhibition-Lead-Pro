import { usersTable, scansTable } from "@workspace/db";
import { and, isNull, ne, or, sql, type SQL } from "drizzle-orm";

// The platform's reporting definitions — one place, so the Platform Dashboard, the
// Platform Owner Analytics and the per-company counts can never disagree about what a
// "user", a "capture" or a "card scan" is. These are WHERE fragments, not queries.

/**
 * A company user that exists today: not a soft-deleted account, and not a platform
 * operator (the operator's own account is not a customer user).
 */
export const TENANT_USER: SQL = and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`)!;

/**
 * A capture: any row of the scans table that is not soft-deleted. The table holds one row
 * per capture — card images read by OCR, and also every contact saved without OCR (QR,
 * vCard, digital card, e-mail signature, NFC, typed in, imported), which is written with
 * extraction_method = 'manual' and its real origin in capture_source.
 */
export const LIVE_CAPTURE: SQL = isNull(scansTable.deletedAt);

/**
 * A card scan: a capture that went through OCR, i.e. not a 'manual' row. extraction_method
 * says only whether OCR ran — it is never the capture source.
 */
export const OCR_CARD_SCAN: SQL = and(LIVE_CAPTURE, or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual")))!;
