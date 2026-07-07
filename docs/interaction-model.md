# Contact vs Interaction Model & Duplicate Detection

**Status:** Live (July 2026). This document presents the interaction data model, the weighted duplicate-detection engine, and the human-in-the-loop resolution flow.

## The core idea

A **Contact** is a person. An **Interaction** is one moment you met them — a card scan at a booth, a QR exchange at a conference, an NFC tap, or a manual entry. Before this change, re-scanning a known person either silently linked to the original or created a stray duplicate. Now **every capture is a permanent interaction record**, and the *user* — never the system — decides what happens when an existing contact is recognized.

```
Contact (person)                    Interactions (moments met)
┌─────────────────────┐             ┌──────────────────────────────────────────┐
│ Dana Ruiz           │ 1 ─────── * │ 2026-03-02  scan   @ SaaStr Annual  (SF) │
│ VP Sales, DupeCo    │             │ 2026-05-11  qr     @ Web Summit          │
│ dana@dupeco.com     │             │ 2026-07-01  manual (office visit, notes) │
└─────────────────────┘             └──────────────────────────────────────────┘
```

## Data model

Interactions are anchored on the existing `scans` table (no new table, no data migration risk). Additive columns:

| Column | Purpose |
|---|---|
| `event_id` | Which event the capture happened at (tenant-validated FK) |
| `latitude` / `longitude` / `gps_accuracy` | Where the capture happened |
| `notes` | Capture-time context ("met at the espresso bar") |
| `ai_summary` | Optional AI summary of the interaction |
| `deleted_at` | Soft delete — history is never destroyed |

- Manual, QR, vCard and NFC contact creations also record an interaction row (`capture_source`), so history is complete regardless of capture method. Existing contacts were backfilled with a synthetic `manual` interaction.
- Deleting a contact **soft-deletes** its interactions (`deleted_at` set, rows kept), hand-replicating the old FK cascade inside one transaction.

## Weighted 4-tier duplicate matching

Each signal contributes a 0–100 confidence (max wins, reasons accumulate):

| Tier | Signal | Confidence |
|---|---|---|
| **Highest** | Same email | 100 |
| | Same mobile number | 95 |
| **High** | Same LinkedIn profile | 90 |
| | Same office phone | 88 |
| **Medium** | Same name + company | 75 |
| | Similar name at same company (fuzzy) | 70 |
| | Same full name only | 65 |
| | Same company only | 55 |
| **Low** | Same website | 45 |
| | Same address | 40 |

**Prompt threshold = 88.** Only unique-identifier-grade signals (email, mobile, LinkedIn, office phone) can trigger the "existing contact found" prompt. Name/company/website/address similarity alone never interrupts the user — those remain background suggestions in the dedup review screen.

## Human-in-the-loop resolution — never auto-merge

`POST /api/contacts` with no `dedupeResolution` and a match ≥ 88 returns **409**:

```json
{
  "code": "existing_contact_found",
  "contact": { "...full existing contact..." },
  "matches": [{ "confidence": 100, "reasons": ["Same email address"], "isLead": true, "isCustomer": false }],
  "previousEvents": ["SaaStr Annual", "Web Summit"],
  "interactionCount": 2,
  "lastInteractionDate": "2026-05-11T09:14:00Z"
}
```

The client shows the prompt; the user picks one of three resolutions:

| Choice | Request | Result |
|---|---|---|
| **Add interaction** | re-POST with `dedupeResolution: "add_interaction"`, `matchedContactId` | 201 — the existing contact is returned; the capture becomes a new interaction on it. No contact data is overwritten. |
| **Create separate** | re-POST with `dedupeResolution: "create_separate"` | 201 — a distinct new contact (genuinely different person). |
| **Review existing** | none | Client navigates to the existing contact's detail page. |

Safety properties (all covered by tests in `artifacts/api-server/test/interactions-dedupe.test.ts`):

- Nothing is ever auto-merged; the 409 is informational, not an action.
- `matchedContactId` is tenant-validated — cross-tenant targets are rejected.
- The interactions read (`GET /contacts/{id}/interactions`) is tenant-isolated (cross-tenant → 404).

## Where interactions surface

- **Contact detail (web + mobile):** an Interactions section — date, capture source, event, captured-by user, notes, GPS — plus interaction entries merged into the activity timeline.
- **Organization page:** `interactionCount`, `eventsAttended`, `lastInteractionDate`, and `recentEmployeesMet` (which people at that company you met most recently).
- **AI (Stage 5A insights + 5B copilot):** contact context now includes the full interaction history ("met 3 times, last at Web Summit"), so follow-up drafts and insights are grounded in real relationship depth — same safety contract as always: real CRM data only, no writes, no auto-send.

## API surface (additive, contract-first)

| Endpoint | Change |
|---|---|
| `POST /api/contacts` | `scanId`, `dedupeResolution`, `matchedContactId` inputs; 409 `ExistingContactFound` response |
| `GET /api/contacts/{id}/interactions` | new — `{ interactions[], total }` |
| `GET /api/contacts/{id}/timeline` | includes `kind: "interaction"` entries |
| `GET /api/organizations/{id}` | + `interactionCount`, `eventsAttended`, `lastInteractionDate`, `recentEmployeesMet` |
| `POST /api/scans` / `GET /api/scans/{id}` | + `eventId`, GPS fields, `notes`, `aiSummary` |

All defined in `lib/api-spec/openapi.yaml` first, then generated into React Query hooks + Zod schemas (Orval).
