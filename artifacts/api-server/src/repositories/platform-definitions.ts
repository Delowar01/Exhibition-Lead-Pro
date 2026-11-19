import { usersTable, scansTable } from "@workspace/db";
import { and, isNull, ne, or, sql, type SQL } from "drizzle-orm";

// The platform's reporting definitions in one place: what a "user", a "capture" and a
// "card scan" are on the Platform Dashboard (totals and scan trend), in Platform Owner
// Analytics and in the per-company counts. These are WHERE fragments, not queries.
//
// Reporting only. The scan quota of a subscription (subscriptions.repository
// countScansInWindow) is an entitlement rule with its own conditions and is not built
// from these.

/**
 * A company user that exists today: not a soft-deleted account, and not a platform
 * operator (the operator's own account is not a customer user).
 */
export const TENANT_USER: SQL = and(isNull(usersTable.deletedAt), sql`${usersTable.role} is distinct from 'platform_owner'`)!;

/**
 * A capture: any row of the scans table that is not soft-deleted. The table holds one row
 * per capture — card images sent for OCR, and also every contact saved without OCR (QR,
 * vCard, digital card, e-mail signature, NFC, typed in), which is written with
 * extraction_method = 'manual' and its real origin in capture_source.
 */
export const LIVE_CAPTURE: SQL = isNull(scansTable.deletedAt);

/**
 * A card scan: a capture sent for OCR, i.e. not a 'manual' row — whatever the outcome
 * (a scan that is still processing or that failed is a card scan too). extraction_method
 * says only whether OCR was involved — it is never the capture source.
 */
export const OCR_CARD_SCAN: SQL = and(LIVE_CAPTURE, or(isNull(scansTable.extractionMethod), ne(scansTable.extractionMethod, "manual")))!;
