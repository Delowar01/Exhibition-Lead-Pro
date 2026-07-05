---
name: Polymorphic custom-field values have no FK cascade
description: Why any hard-delete or merge of a contact/lead must manually delete its custom_field_values in the same transaction
---

Custom-field VALUES are polymorphic (`custom_field_values.entityType` = `"contact"`|`"lead"` + `entityId`), so there is **no foreign key** from a value row to its owning contact/lead — and therefore **no `onDelete` cascade**.

**Rule:** any operation that hard-deletes an owner row (e.g. the contact merge in `mergeTransaction`) MUST also delete that owner's custom-field values (`entityType` + `entityId in dupIds`) inside the **same transaction**. A soft-delete of a custom-field *definition* similarly must delete its values in-txn (definitions do own their values via `definitionId`, but the cleanup is still manual by convention here).

**Why:** without the manual delete, merged-away/deleted entities leave orphaned value rows that (a) never get garbage-collected, and (b) can resurface if an entity id is ever reused. It typechecks and passes shallow tests because nothing reads them — the leak is silent.

**How to apply:** when adding any new hard-delete/merge path for contacts or leads, add a `delete(customFieldValuesTable).where(entityType == X and entityId in ids)` to the same txn. The polymorphic design is deliberate (one values table for many entity types) — do not "fix" it by adding real FKs.

---

## Definition defaultValue must be re-validated when the CONSTRAINING SHAPE changes

A custom-field `defaultValue` is only meaningful relative to the field's type + options + validation. On definition UPDATE it is NOT enough to validate a *newly supplied* default — a **stored** default can silently become invalid when `fieldType`, `options`, OR `validation` change without the caller re-sending `defaultValue` (e.g. dropdown default `"A"` while options change to `["B"]`; a 3-char text default while `minLength` rises to 5).

**Rule:** on update, if `defaultValue` is provided, validate it against the *effective* (new-or-existing) type/options/validation; else if any of fieldType/options/validation changed and a stored default exists, re-run that same validation on the stored default and reject (400) if now invalid. Validate on CREATE too (route through the shared type-validator, minus the required check).

**Why:** validating only the incoming value leaves an inconsistent default that later auto-applies a value the field's own rules forbid — passes typecheck + shallow tests because nothing re-checks stored defaults.

## Required-field + default enforcement lives at the value-WRITE boundary, not create

Required custom-fields are enforced in `setValues` (the explicit PUT `/…/:id/custom-fields` endpoint), NOT during contact/lead creation — so entity create is unaffected. Enforcement is over the **merged** state: payload values + already-stored values + configured defaults. An explicit `null` on a required field is a deliberate clear → 400; a required field left unsatisfied after the merge → 400; a configured default is auto-applied for a definition omitted from the payload that has no existing value. Because the values repo deletes a row on null, "never set" and "explicitly cleared then omitted" are indistinguishable, so an omitted optional field with a default re-acquires the default on the next write — accepted tradeoff, not a bug.
