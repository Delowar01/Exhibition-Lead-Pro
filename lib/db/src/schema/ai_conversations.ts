import { pgTable, serial, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Stage 5D — Enterprise AI Command Center: persisted conversation memory.
//
// Conversations are STRICTLY per-user, per-tenant: every read/write is scoped by
// (companyId, userId) — a conversation is never visible to another user, and NEVER
// crosses a tenant boundary. Soft-deleted via deletedAt (user "Delete conversation").
//
// SAFETY CONTRACT: the assistant is ADVISORY ONLY. A conversation/message row never
// executes anything — no CRM writes, no emails/WhatsApp, no assignments. Suggested
// actions stored on a message are NAVIGATION/DRAFT suggestions the user must act on
// through the existing manual, audited endpoints.
export const aiConversationsTable = pgTable("ai_conversations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }), // owner (per-user memory)
  title: text("title").notNull().default("New conversation"),
  // Optional screen context the conversation was opened from (context awareness).
  contextType: text("context_type"), // lead | contact | organization | event | business_card | document | null
  contextId: integer("context_id"),
  lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("ai_conversations_company_user_idx").on(t.companyId, t.userId),
  index("ai_conversations_last_message_idx").on(t.lastMessageAt),
]);

// One row per message. Assistant messages carry full provenance: intent, source
// (deterministic | ai), confidence, provider/model/promptKey/promptVersion (null for
// deterministic rows — deterministic answers NEVER masquerade as AI), plus the
// structured grounded payload (`data`), the supporting CRM evidence (`evidence`) and
// the advisory suggested actions (`suggestedActions`).
export const aiMessagesTable = pgTable("ai_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => aiConversationsTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // denormalized tenant boundary for defense-in-depth scoping
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(), // display text (user query or assistant answer)
  intent: text("intent"), // classified intent for assistant rows (search, priorities, ...)
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // structured grounded payload
  evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]), // supporting CRM records [{type,id,label}]
  suggestedActions: jsonb("suggested_actions").$type<unknown[]>().notNull().default([]), // advisory [{label,type,target}]
  confidence: integer("confidence"), // 0-100 (null for user rows)
  source: text("source"), // deterministic | ai (null for user rows)
  provider: text("provider"), // null for deterministic/user rows
  model: text("model"),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ai_messages_conversation_idx").on(t.conversationId),
  index("ai_messages_company_idx").on(t.companyId),
]);

export const insertAiConversationSchema = createInsertSchema(aiConversationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiConversation = z.infer<typeof insertAiConversationSchema>;
export type AiConversation = typeof aiConversationsTable.$inferSelect;

export const insertAiMessageSchema = createInsertSchema(aiMessagesTable).omit({ id: true, createdAt: true });
export type InsertAiMessage = z.infer<typeof insertAiMessageSchema>;
export type AiMessage = typeof aiMessagesTable.$inferSelect;
