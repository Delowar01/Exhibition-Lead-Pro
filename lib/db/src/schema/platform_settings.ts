import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

// Platform-wide settings (not tenant data): one row per setting key, the value a JSON
// document owned by the service that defines the key. The only key today is
// "ai_providers" — the Platform Owner's AI provider policy (which providers are enabled,
// the primary, automatic fallback, models, monthly spending limits).
//
// There is deliberately NO company_id: these rows are never read through a tenant route
// and never joined to tenant data. An ABSENT row === the documented defaults of that
// setting, so a database without the row (or, before the reviewed change is applied,
// without the table) behaves exactly like one where nothing was ever changed.
//
// `version` is an optimistic-concurrency counter: an update names the version it read and
// is refused when another change landed in between. `updated_by` is the acting user's id
// for display only (the audit log holds the durable record of who changed what).
//
// Reviewed equivalent: lib/db/migrations/0042_platform_settings.sql (additive, idempotent).
export const platformSettingsTable = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PlatformSetting = typeof platformSettingsTable.$inferSelect;
