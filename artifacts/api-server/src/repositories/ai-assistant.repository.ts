import { db, aiConversationsTable, aiMessagesTable } from "@workspace/db";
import type { AiConversation, AiMessage } from "@workspace/db";
import { and, eq, desc, asc, ilike } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine, notDeleted } from "./base.js";

// Data access for Stage 5D AI Command Center conversation memory. Conversations are
// STRICTLY per-user, per-tenant: every read/write combines tenantScope (never companyId
// alone) with an eq(userId) owner check, so history can never cross a tenant boundary
// OR leak between users of the same tenant. Deletion is a soft delete (deletedAt).

function ownerScope(user: AuthUser, extra?: ReturnType<typeof eq>[]) {
  return combine(
    tenantScope(user, aiConversationsTable.companyId),
    eq(aiConversationsTable.userId, user.id),
    notDeleted(aiConversationsTable.deletedAt),
    ...(extra ?? []),
  );
}

export async function listConversations(user: AuthUser, q?: string, limit = 50): Promise<AiConversation[]> {
  const search = q && q.trim() ? ilike(aiConversationsTable.title, `%${q.trim()}%`) : undefined;
  return db
    .select()
    .from(aiConversationsTable)
    .where(combine(ownerScope(user), search))
    .orderBy(desc(aiConversationsTable.lastMessageAt))
    .limit(limit);
}

export async function createConversation(input: {
  companyId: number;
  userId: number;
  title: string;
  contextType?: string | null;
  contextId?: number | null;
}): Promise<AiConversation> {
  const [row] = await db
    .insert(aiConversationsTable)
    .values({
      companyId: input.companyId,
      userId: input.userId,
      title: input.title,
      contextType: input.contextType ?? null,
      contextId: input.contextId ?? null,
    })
    .returning();
  return row;
}

export async function findConversation(user: AuthUser, id: number): Promise<AiConversation | undefined> {
  const [row] = await db
    .select()
    .from(aiConversationsTable)
    .where(ownerScope(user, [eq(aiConversationsTable.id, id)]))
    .limit(1);
  return row;
}

export async function softDeleteConversation(user: AuthUser, id: number): Promise<AiConversation | undefined> {
  const [row] = await db
    .update(aiConversationsTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(ownerScope(user, [eq(aiConversationsTable.id, id)]))
    .returning();
  return row;
}

export async function touchConversation(id: number, title?: string): Promise<void> {
  await db
    .update(aiConversationsTable)
    .set({ lastMessageAt: new Date(), updatedAt: new Date(), ...(title ? { title } : {}) })
    .where(eq(aiConversationsTable.id, id));
}

export async function listMessages(companyId: number, conversationId: number, limit = 200): Promise<AiMessage[]> {
  return db
    .select()
    .from(aiMessagesTable)
    .where(and(eq(aiMessagesTable.companyId, companyId), eq(aiMessagesTable.conversationId, conversationId)))
    .orderBy(asc(aiMessagesTable.createdAt))
    .limit(limit);
}

export interface InsertMessageInput {
  conversationId: number;
  companyId: number;
  role: "user" | "assistant";
  content: string;
  intent?: string | null;
  data?: Record<string, unknown>;
  evidence?: unknown[];
  suggestedActions?: unknown[];
  confidence?: number | null;
  source?: "deterministic" | "ai" | null;
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
}

export async function insertMessage(input: InsertMessageInput): Promise<AiMessage> {
  const [row] = await db
    .insert(aiMessagesTable)
    .values({
      conversationId: input.conversationId,
      companyId: input.companyId,
      role: input.role,
      content: input.content,
      intent: input.intent ?? null,
      data: input.data ?? {},
      evidence: input.evidence ?? [],
      suggestedActions: input.suggestedActions ?? [],
      confidence: input.confidence ?? null,
      source: input.source ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
    })
    .returning();
  return row;
}

// Recent assistant activity across the user's conversations (for the dashboard).
export async function recentAssistantMessages(user: AuthUser, limit = 10): Promise<AiMessage[]> {
  if (user.companyId == null) return [];
  const rows = await db
    .select({ msg: aiMessagesTable })
    .from(aiMessagesTable)
    .innerJoin(aiConversationsTable, eq(aiMessagesTable.conversationId, aiConversationsTable.id))
    .where(
      combine(
        tenantScope(user, aiMessagesTable.companyId),
        eq(aiConversationsTable.userId, user.id),
        eq(aiMessagesTable.role, "assistant"),
        notDeleted(aiConversationsTable.deletedAt),
      ),
    )
    .orderBy(desc(aiMessagesTable.createdAt))
    .limit(limit);
  return rows.map((r) => r.msg);
}
