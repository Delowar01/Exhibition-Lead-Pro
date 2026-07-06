---
name: Apply-handoff field mapping is per-entity
description: The AI "Apply" button maps a recommendation to a manual PATCH field — that field must exist on the target entity's schema, which differs between leads and contacts.
---

The AI Workflow/Copilot "Apply" button never introduces a new write path — it routes the recommended value through the EXISTING manual CRM endpoint (`PATCH /leads` or `PATCH /contacts`). So the mapped field MUST be a real column on that entity.

**The asymmetry that bit us:** `contacts` have BOTH `assignedToId` AND `followUpDate`. `leads` have `assignedToId` but NO `followUpDate` column. A shared `applyTarget()` that mapped `follow_up`/`due_date` → `followUpDate` for both entities produced, for a lead, a PATCH body with only an unknown field → the route strips it → empty `updateData` → 400 (the same empty-set guard other PATCH routes have).

**Why:** the recommendation *types* are entity-agnostic (a lead and a contact can both get a "follow_up" recommendation) but the *writable fields* are not. Mapping must be gated on `entityType`.

**How to apply:** in `applyTarget()` (web `WorkflowIntelligencePanel.tsx`, mobile `WorkflowSection.tsx`) gate the `followUpDate` branch with `entityType === "contact"`. When adding any new Apply mapping, confirm the target field is in that entity's `*Update` schema (`LeadUpdate` vs `ContactUpdate`) — a field on one is not guaranteed on the other. Tests that exercise the lead apply path must use a real lead column (`assignedToId`), not `followUpDate`.
