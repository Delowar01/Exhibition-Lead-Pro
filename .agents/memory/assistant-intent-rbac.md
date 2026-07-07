---
name: Assistant intent RBAC mirrors module perms
description: Conversational assistant intents must gate on the target module's own permission, not a sibling module's.
---
The AI assistant is just another read surface over CRM modules. Every intent handler must re-check the permission of the module it actually reads (e.g. a company search gates on organizations.view, not contacts.view), or the assistant becomes an RBAC bypass route.

**Why:** An architect review caught a company-search intent gated on contacts.view — an employee with contacts-only perms could enumerate organizations through chat while the Companies page itself was blocked.

**How to apply:** When adding an assistant/copilot intent, mirror the exact `requirePermission`/`can()` module+action used by the module's own route. Also verify suggested-action `navigate` targets against real client routes (they aren't typechecked). Add a bypass regression test: grant assistant use + a sibling module perm, assert denied text and zero leaked rows.
