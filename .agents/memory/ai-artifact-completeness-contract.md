---
name: AI artifact completeness contract (enums, forecast dims, provenance)
description: Declared-but-unemitted enum members, missing forecast dimensions, and un-stamped provenance are silent completeness bugs even when everything typechecks/tests green.
---

When an AI intelligence surface (executive/copilot/insight/workflow) declares a taxonomy or contract, the taxonomy is load-bearing — shipping a subset is a completeness bug that code review catches even though typecheck + tests pass.

Three recurring traps:
- **Declared-but-never-emitted enum member.** An `AlertType`/kind union listing a value (e.g. `team_overload`) that the compute function never produces is a bug. Either emit it from a deterministic grounded rule or remove it from the union. Add a test that asserts every generated item's type is in the known set AND (if feasible) that the previously-missing type can surface and is grounded (confidence 100).
- **Forecast/dimension coverage.** A forecast engine must project every dimension the task lists (revenue, pipeline, leads, lead_conversion, workload/resource-needs, upcoming-risk), each over its OWN real series with an honest unit/label — never silently default to the revenue series. Grounded proxies are OK if labelled honestly with an assumption line (e.g. risk = new leads − won per month).
- **Provenance stamped in persistence AND contract.** Even a purely deterministic artifact (reports) must stamp confidence + source in the DB write AND expose confidence/source/provider/model/promptVersion in the API response schema + mapper. Deterministic rows carry confidence (100) with provider/model/promptVersion = null (honest, never AI masquerade). DB columns existing is not enough — the response mapper and OpenAPI schema must surface them.

**Why:** each of these typechecks and passes shallow tests, so they slip through unless you cross-check the implementation against the stated feature taxonomy. Code review rejected a Stage 5C submission for exactly these three.

**How to apply:** before marking an AI-surface task complete, diff the declared taxonomy (unions, required forecast types, provenance fields) against what the code actually emits/returns, and add tests that pin each declared member.
