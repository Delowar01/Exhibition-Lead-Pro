// Biometric quick sign-in — remembered-account clarity (B25 Stage 1), as a
// pure, framework-free model so lib/biometric.ts stays a thin storage shell and
// the rules below are unit-tested.
//
// The secret vault (`csp_biometric_vault`, hardware-backed secure store) keeps
// the session of the ONE account that enabled biometric sign-in, and it
// survives logout on purpose. What the login screen needs in order to offer
// that sign-in is not the secret but the DESTINATION: which account the
// biometric action opens. That lives in a separate, non-secret record
// (`csp_biometric_account`) holding only the stable account identity and a
// masked e-mail, so the screen never reads the vault just to draw a button.
//
// Rules:
//   • identity is the shared stable key `<userId>@<companyId>` (accountOwnerKey),
//     never an e-mail — the same e-mail in another tenant is another account;
//   • a vault whose destination cannot be established (legacy build, missing or
//     malformed record, record/vault mismatch) is never offered as a generic
//     "sign in with biometrics": it is hidden until proven, or invalidated;
//   • after a SUCCESSFUL password/MFA/biometric login the vault is reconciled
//     against the authenticated account: same owner → keep it and refresh the
//     hint (which also migrates a legacy vault), a different or unidentifiable
//     owner → clear vault and hint; a failed attempt and a plain logout never
//     touch the vault;
//   • the hint carries no token, no password and no raw e-mail.
import { accountOwnerKey } from "./settings-model";

/** Stable account identity of a stored user record, or null when it has none. */
export function ownerOfStoredUser(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const u = value as { id?: unknown; companyId?: unknown };
  if (!isPositiveInt(u.id)) return null;
  if (u.companyId !== undefined && u.companyId !== null && !isPositiveInt(u.companyId)) return null;
  return accountOwnerKey({ id: u.id, companyId: u.companyId as number | null | undefined });
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

const ACCOUNT_OWNER = /^[1-9][0-9]*@([1-9][0-9]*|platform)$/;

export function isAccountOwnerKey(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_OWNER.test(value);
}

/** Marker every displayed account hint carries. */
export const EMAIL_MASK = "***";

/**
 * Privacy-safe account hint: at most the first character of the local part,
 * the rest replaced by `***`, the domain kept. A one-character local part is
 * masked entirely (showing it would show the whole local part).
 *   daniel@example.com → d***@example.com
 *   ab@example.com     → a***@example.com
 *   a@example.com      → ***@example.com
 *   nodomain           → n***
 * Missing, blank or non-string input yields null (no hint, nothing offered).
 */
export function maskEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email) return null;
  const at = email.indexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  const domain = at < 0 ? "" : email.slice(at + 1).trim();
  const chars = Array.from(local);
  const lead = chars.length >= 2 ? chars[0] : "";
  const masked = `${lead}${EMAIL_MASK}`;
  return domain ? `${masked}@${domain}` : masked;
}

/** Non-secret destination of the biometric action. */
export interface BiometricAccountHint {
  /** `<userId>@<companyId>` of the account the vault opens. */
  owner: string;
  /** Masked e-mail shown on the login screen, e.g. d***@example.com. */
  emailHint: string;
}

/** The hint for an authenticated user, or null when no safe hint can be made. */
export function biometricAccountHint(user: unknown): BiometricAccountHint | null {
  const owner = ownerOfStoredUser(user);
  const emailHint = maskEmail((user as { email?: unknown } | null)?.email);
  return owner && emailHint ? { owner, emailHint } : null;
}

/** Exactly two fields are persisted — never a token, password or raw e-mail. */
export function serializeBiometricAccountHint(hint: BiometricAccountHint): string {
  return JSON.stringify({ owner: hint.owner, emailHint: hint.emailHint });
}

/**
 * Parse the persisted hint. Anything that is not a well-formed, MASKED hint
 * with a stable owner is null: no destination, nothing offered (fail safe).
 */
export function parseBiometricAccountHint(raw: string | null): BiometricAccountHint | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { owner?: unknown; emailHint?: unknown } | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    if (!isAccountOwnerKey(p.owner)) return null;
    const hint = p.emailHint;
    if (typeof hint !== "string" || !hint.includes(EMAIL_MASK) || /\s/.test(hint) || hint.length > 254) return null;
    return { owner: p.owner, emailHint: hint };
  } catch {
    return null;
  }
}

/**
 * The secret vault as stored. `present: true` with `owner: null` is a vault
 * that exists but cannot be attributed (malformed, or written by an unknown
 * shape): it is never used and is cleared at the next successful login.
 */
export type StoredVault =
  | { present: false }
  | { present: true; owner: string | null; token: string | null; user: unknown };

export function parseStoredVault(raw: string | null): StoredVault {
  if (!raw) return { present: false };
  const unidentified: StoredVault = { present: true, owner: null, token: null, user: null };
  try {
    const p = JSON.parse(raw) as { token?: unknown; user?: unknown } | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return unidentified;
    const owner = ownerOfStoredUser(p.user);
    const token = typeof p.token === "string" && p.token.length > 0 ? p.token : null;
    if (!owner || !token) return unidentified;
    return { present: true, owner, token, user: p.user };
  } catch {
    return unidentified;
  }
}

export type BiometricReconcileAction =
  /** No vault: nothing to keep (and no orphan hint may remain). */
  | { kind: "none" }
  /** Same account just authenticated: keep the vault, (re)write its hint. */
  | { kind: "keep"; hint: BiometricAccountHint }
  /** Another — or an unidentifiable — account: clear vault and hint. */
  | { kind: "clear" };

/**
 * Decide what happens to the remembered biometric account AFTER a successful
 * login. Equality is the stable owner key only, never the e-mail.
 */
export function reconcileBiometricOwner(vault: StoredVault, authenticatedUser: unknown): BiometricReconcileAction {
  if (!vault.present) return { kind: "none" };
  const owner = ownerOfStoredUser(authenticatedUser);
  if (!owner || vault.owner === null || vault.owner !== owner) return { kind: "clear" };
  const hint = biometricAccountHint(authenticatedUser);
  return hint ? { kind: "keep", hint } : { kind: "clear" };
}

export type BiometricSignInTarget =
  /** The vault is the advertised destination: sign in as that account. */
  | { kind: "login"; owner: string; token: string; user: unknown }
  /** No usable vault, or not the advertised destination: clear vault + hint. */
  | { kind: "invalidate" };

/** After a successful biometric prompt: only the advertised account may be opened. */
export function biometricSignInTarget(vault: StoredVault, destination: BiometricAccountHint | null): BiometricSignInTarget {
  if (!destination || !vault.present || vault.owner === null || vault.token === null) return { kind: "invalidate" };
  if (vault.owner !== destination.owner) return { kind: "invalidate" };
  return { kind: "login", owner: vault.owner, token: vault.token, user: vault.user };
}
