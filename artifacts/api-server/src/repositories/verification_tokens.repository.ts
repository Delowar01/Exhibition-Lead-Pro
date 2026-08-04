import { db, verificationTokensTable } from "@workspace/db";
import { and, eq, isNull, gt, lt } from "drizzle-orm";

export type TokenType = "password_reset" | "email_verify";

export async function insertToken(values: {
  userId: number;
  type: TokenType;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(verificationTokensTable).values(values);
}

// Finds a live (unused, unexpired) token row by its hash + type. Lookup is by the
// SHA-256 of the raw token presented by the user, so the raw token is never compared
// against stored plaintext.
export async function findLiveToken(tokenHash: string, type: TokenType) {
  const [row] = await db
    .select()
    .from(verificationTokensTable)
    .where(
      and(
        eq(verificationTokensTable.tokenHash, tokenHash),
        eq(verificationTokensTable.type, type),
        isNull(verificationTokensTable.usedAt),
        gt(verificationTokensTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row;
}

export async function markUsed(id: number): Promise<void> {
  await db.update(verificationTokensTable).set({ usedAt: new Date() }).where(eq(verificationTokensTable.id, id));
}

// Atomically consumes a token: the conditional UPDATE only succeeds while the row is
// still unused + unexpired, so two concurrent resets with the same token cannot both
// pass — exactly one caller gets the row back, the other gets undefined.
export async function consumeToken(id: number) {
  const [row] = await db
    .update(verificationTokensTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(verificationTokensTable.id, id),
        isNull(verificationTokensTable.usedAt),
        gt(verificationTokensTable.expiresAt, new Date()),
      ),
    )
    .returning();
  return row;
}

// Invalidates any outstanding tokens of a type for a user (e.g. before issuing a new
// reset link, or after a successful reset) so only the latest link is ever live.
export async function invalidateOutstanding(userId: number, type: TokenType): Promise<void> {
  await db
    .update(verificationTokensTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(verificationTokensTable.userId, userId),
        eq(verificationTokensTable.type, type),
        isNull(verificationTokensTable.usedAt),
      ),
    );
}

// Best-effort cleanup of expired rows (called opportunistically; not required for
// correctness since findLiveToken already filters on expiry).
export async function deleteExpired(): Promise<void> {
  await db.delete(verificationTokensTable).where(lt(verificationTokensTable.expiresAt, new Date()));
}
