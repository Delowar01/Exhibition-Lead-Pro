// Phase 2 Batch 1 — session renewal and session end, as pure rules.
//
// The API already issues a refresh token at sign-in and rotates it at
// POST /auth/refresh (the web portal uses exactly this). The mobile app now
// uses it too: when a request is rejected with 401 the session is renewed once
// and the request is retried. No new server capability is involved.
//
// The rules here decide WHAT may happen; contexts/AuthContext.tsx does it.
//   • A rejected request is retried only under the session it was sent with.
//     One that was sent before a sign-out, or before another account signed in,
//     is never retried under the new session.
//   • The refresh token is single-use and the server revokes the whole session
//     when an old one is presented again. So concurrent rejections share one
//     renewal, and a request rejected with a token that was already replaced is
//     simply retried with the current one — no second renewal.
//   • Only a definite answer from the API (its own 401 / 403 on the renewal
//     itself) ends the session. No connection, a timeout, a server error or a
//     refusal by something in between leave it as it is: the user is not
//     signed out because the network dropped.
//   • A 401 that is about a typed password (change password, MFA off, new
//     backup codes) is not about the session and touches nothing.
//   • When the session has ended the user is told why, on the sign-in screen;
//     captures waiting on the device stay there for the same account.

export type SessionEndReason =
  /** The server no longer accepts the session (expired, signed out elsewhere, password changed, revoked). */
  | "expired"
  /** The account or its organization is not allowed in at the moment. */
  | "blocked";

export interface SessionSnapshot {
  /** Changes at every sign-in, sign-out and session end — and at nothing else; a renewal keeps it. */
  generation: number;
  accessToken: string | null;
  refreshToken: string | null;
  /** Access tokens this session has carried (the current one last). */
  issuedTokens: readonly string[];
}

export type UnauthorizedDecision =
  /** Renew the session with its refresh token, then retry. */
  | { action: "refresh"; refreshToken: string }
  /** The session was renewed meanwhile: retry with the current token, renew nothing. */
  | { action: "retry"; token: string }
  /** Do not retry and change nothing (no session, or the request belongs to another one). */
  | { action: "ignore" }
  /** The session cannot be renewed: it has ended. */
  | { action: "end"; reason: SessionEndReason };

/**
 * Requests whose 401 is about a PASSWORD the user typed, not about the session:
 * the API answers 401 "incorrect password" on these while the session is
 * perfectly valid. Such an answer must neither renew nor end the session — the
 * screen shows it as what it is.
 */
const CREDENTIAL_CHECK_PATHS = ["/auth/change-password", "/auth/mfa/disable", "/auth/mfa/backup-codes"] as const;

export function isCredentialCheckRequest(url: string | null | undefined): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/)[0] ?? "";
  return CREDENTIAL_CHECK_PATHS.some((p) => path.endsWith(p));
}

/** What to do about a request that came back 401, given the token it was sent with and where it was sent. */
export function decideOnUnauthorized(session: SessionSnapshot, failedToken: string | null, url?: string | null): UnauthorizedDecision {
  if (isCredentialCheckRequest(url)) return { action: "ignore" }; // a wrong password, not a dead session
  if (!session.accessToken) return { action: "ignore" }; // signed out: nothing to renew, nobody to sign out
  if (failedToken === null) return { action: "ignore" }; // sent without a session: not this session's concern
  if (failedToken !== session.accessToken) {
    // Sent with a token that is no longer current. Same session → it was renewed
    // while the request was under way. Otherwise it is another session's request.
    return session.issuedTokens.includes(failedToken) ? { action: "retry", token: session.accessToken } : { action: "ignore" };
  }
  if (!session.refreshToken) return { action: "end", reason: "expired" };
  return { action: "refresh", refreshToken: session.refreshToken };
}

export type RefreshFailure =
  /** The server refused the renewal: the session is over. */
  | { kind: "ended"; reason: SessionEndReason }
  /** No answer or a server-side problem: keep the session, fail only this request. */
  | { kind: "transient" };

/**
 * Classify what the renewal request threw. Only a definite refusal BY THE API
 * ends the session: its refusals are JSON objects with an `error` text. A 401
 * or 403 produced by something in between (a proxy, a firewall, the sign-in
 * page of a public Wi-Fi) is not the API's verdict and leaves the session alone.
 */
export function classifyRefreshFailure(err: unknown): RefreshFailure {
  if (!err || typeof err !== "object") return { kind: "transient" };
  const { status, data } = err as { status?: unknown; data?: unknown };
  const fromApi = !!data && typeof data === "object" && !Array.isArray(data) && typeof (data as { error?: unknown }).error === "string";
  if (!fromApi) return { kind: "transient" };
  if (status === 401) return { kind: "ended", reason: "expired" };
  if (status === 403) return { kind: "ended", reason: "blocked" };
  return { kind: "transient" };
}

/** A renewal answer is usable only when it carries both new tokens. */
export function parseRefreshResponse(value: unknown): { token: string; refreshToken: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || v.token.length === 0) return null;
  if (typeof v.refreshToken !== "string" || v.refreshToken.length === 0) return null;
  return { token: v.token, refreshToken: v.refreshToken };
}

/** The tokens a session has carried, with the newest appended (bounded; duplicates removed). */
export function withIssuedToken(issued: readonly string[], token: string): string[] {
  return [...issued.filter((t) => t !== token), token].slice(-8);
}

/** i18n key of the notice shown on the sign-in screen after a session ended by itself. */
export function sessionEndNoticeKey(reason: SessionEndReason): string {
  return reason === "blocked" ? "auth.sessionBlockedNotice" : "auth.sessionExpiredNotice";
}

/** How long after a session ended a capture already under way may still be kept for its account. */
export const ENDED_OWNER_GRACE_MS = 2 * 60_000;

export interface EndedSession {
  /** Owner key (`<userId>@<companyId>`) of the session that ended. */
  owner: string;
  at: number;
}

/**
 * The account a just-ended session belonged to, while the grace period lasts.
 * Used for ONE purpose: a capture that was being sent when the session ended is
 * kept on the device for the account that made it, instead of being dropped.
 * It never applies after an explicit sign-out, and never makes anything visible
 * or uploadable — the item waits until that account signs in again.
 */
export function endedOwnerWithinGrace(ended: EndedSession | null, now: number): string | null {
  if (!ended) return null;
  return now - ended.at >= 0 && now - ended.at <= ENDED_OWNER_GRACE_MS ? ended.owner : null;
}
