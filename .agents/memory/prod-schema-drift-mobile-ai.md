---
name: Prod schema drift breaks mobile AI silently
description: Published app's DB missing newer tables makes device-only features 500 while dev works; fix is republish, never hand-migration.
---

# Prod schema drift = silent device-only failure mode

**Rule:** when a feature works in dev/web-preview but fails only on the device APK (which points at the published staging URL), FIRST diff dev vs production schema (database skill, `environment:"production"`). Missing tables/routes in prod mean the deployment is stale — the fix is for the owner to REPUBLISH (the publish flow applies the schema diff). Never write custom prod migrations.

**Why:** "The AI could not generate a response" on device was not an app bug — production had 33 tables vs dev's 64 (all `ai_*` tables missing), and prod also 404'd newer routes (`/api/scans/analyze`). Every assistant send 500'd only in prod.

**How to apply:** device-reported errors against the published backend → check prod schema/route parity before touching app code; put "republish required" in the report and suggest deploy.
