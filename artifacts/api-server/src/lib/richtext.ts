// Portable rich-text helpers for collaborative notes & comments.
//
// The stored `body` is a plain string using a small, safe markup:
//   - markdown subset for formatting: **bold**, *italic*, `- ` bullet lines
//   - mention tokens: `@[Display Name](userId)`
//
// We deliberately DO NOT store HTML — rendering escapes text on the client, so
// there is no XSS surface. The authoritative set of mentioned user ids is always
// derived server-side from the body tokens (never trusted from the client).

const MENTION_RE = /@\[[^\]]{1,120}\]\((\d+)\)/g;

// Extract the distinct user ids referenced by mention tokens in a body.
export function extractMentionIds(body: string): number[] {
  const ids = new Set<number>();
  for (const m of body.matchAll(MENTION_RE)) {
    const id = parseInt(m[1], 10);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return Array.from(ids);
}

// Strip mention tokens down to their display name — used to build short,
// human-readable summaries (notification bodies, timeline previews).
export function toPlainText(body: string): string {
  return body.replace(/@\[([^\]]{1,120})\]\(\d+\)/g, "@$1").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
}

const MAX_BODY = 20000;

// Normalize a body for storage: enforce a max length, collapse excessive blank
// lines. Returns the cleaned string (may be empty — callers reject empties).
export function normalizeBody(input: unknown): string {
  const body = typeof input === "string" ? input : "";
  return body.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").slice(0, MAX_BODY).trim();
}
