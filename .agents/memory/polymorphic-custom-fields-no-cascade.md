---
name: Polymorphic custom-field values have no FK cascade
description: Why any hard-delete or merge of a contact/lead must manually delete its custom_field_values in the same transaction
---

Custom-field VALUES are polymorphic (`custom_field_values.entityType` = `"contact"`|`"lead"` + `entityId`), so there is **no foreign key** from a value row to its owning contact/lead — and therefore **no `onDelete` cascade**.

**Rule:** any operation that hard-deletes an owner row (e.g. the contact merge in `mergeTransaction`) MUST also delete that owner's custom-field values (`entityType` + `entityId in dupIds`) inside the **same transaction**. A soft-delete of a custom-field *definition* similarly must delete its values in-txn (definitions do own their values via `definitionId`, but the cleanup is still manual by convention here).

**Why:** without the manual delete, merged-away/deleted entities leave orphaned value rows that (a) never get garbage-collected, and (b) can resurface if an entity id is ever reused. It typechecks and passes shallow tests because nothing reads them — the leak is silent.

**How to apply:** when adding any new hard-delete/merge path for contacts or leads, add a `delete(customFieldValuesTable).where(entityType == X and entityId in ids)` to the same txn. The polymorphic design is deliberate (one values table for many entity types) — do not "fix" it by adding real FKs.
