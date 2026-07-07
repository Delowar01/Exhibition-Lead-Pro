---
name: Interaction model & human-in-the-loop dedupe
description: Contact captures are permanent interactions on scans; POST /contacts 409s on high-confidence matches; downstream traps.
---

- Every contact creation (any source) writes an interaction row on `scans` (synthetic ones have `imageUrl` AND `extractedData` null). Any consumer that enumerates scans as "business cards" (AI batches, exports, counts) must filter `deletedAt IS NULL` and require image OR extractedData, or synthetic interaction rows inflate/pollute it.
  **Why:** AI business-card batch totals silently jumped after the interaction model landed; typecheck and shallow tests didn't catch it.
  **How to apply:** whenever adding a scan-enumerating feature, ask "is this a card or an interaction?" and filter accordingly.
- `createContact` returns `{status: 201|409, body}` — never a bare Contact. A 409 (`existing_contact_found`) is informational; clients re-POST with `dedupeResolution` (`add_interaction` needs tenant-validated `matchedContactId`). Nothing is ever auto-merged/auto-linked.
  **Why:** owner directive — the user always decides; the old auto-link was removed.
- Prompt threshold (88) deliberately sits so ONLY unique-identifier signals (email/mobile/linkedin/office phone) can interrupt; name/company/website/address stay background suggestions. Test fixtures that intentionally create near-duplicates must send `dedupeResolution: "create_separate"`.
- Contact soft-delete soft-deletes its scans but KEEPS `scans.contactId` (history preserved) — the old set-null cascade expectation is wrong for scans.
