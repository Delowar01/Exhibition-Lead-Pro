// B25 Stage 1 — biometric remembered-account clarity + different-account
// invalidation. The `Device` below drives the pure model exactly the way
// lib/biometric.ts, contexts/AuthContext.tsx, app/login.tsx and
// app/settings.tsx drive the real stores (a `wiring` block at the end pins
// that correspondence to the source). Tokens are synthetic and never printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { BusinessCard } from "@workspace/api-client-react";

import {
  biometricAccountHint,
  biometricSignInTarget,
  maskEmail,
  ownerOfStoredUser,
  parseBiometricAccountHint,
  parseStoredVault,
  reconcileBiometricOwner,
  serializeBiometricAccountHint,
} from "./biometric-account-model";
import { parseStoredCardCache, serializeCardCache, visibleCachedCard } from "./card-cache-model";
import { enqueueItem, queueOwnerKey, visibleQueue } from "./offline-queue-model";
import {
  accountOwnerKey,
  bindSettingsToAccount,
  DEFAULT_SETTINGS,
  selectActiveEvent,
  visibleSettings,
  type AppSettings,
} from "./settings-model";

const MOBILE_ROOT = fileURLToPath(String(new URL("..", import.meta.url)));
const read = (p: string) => readFileSync(join(MOBILE_ROOT, p), "utf8");
const EN = JSON.parse(read("lib/i18n/locales/en.json")) as { auth: Record<string, string> };
const AR = JSON.parse(read("lib/i18n/locales/ar.json")) as { auth: Record<string, string> };
const interpolate = (template: string, vars: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

type U = { id: number; companyId?: number | null; email: string; name: string };
const A: U = { id: 11, companyId: 3, email: "alpha.person@tenant-a.example", name: "A" };
const B: U = { id: 22, companyId: 4, email: "bravo.person@tenant-b.example", name: "B" };
const tokenOf = (u: U) => `SYNTHETIC-NOT-A-TOKEN-${u.id}-${u.companyId ?? "platform"}`;

const VAULT = "csp_biometric_vault";
const HINT = "csp_biometric_account";
const TOKEN = "csp_token";
const USER = "csp_user";
const REMEMBER = "csp_remember_email";
const METHOD = "Fingerprint";

/** One phone: secure store + the account-bound settings + the signed-in session. */
class Device {
  store = new Map<string, string>();
  settings: AppSettings = DEFAULT_SETTINGS;
  session: U | null = null;
  supported = true;

  // settings.tsx toggleBiometric(true) → saveBiometricLogin(token, user)
  enableBiometric(): void {
    const user = this.session;
    if (!user) throw new Error("not signed in");
    const hint = biometricAccountHint(user);
    if (!hint) throw new Error("no stable identity");
    this.store.set(VAULT, JSON.stringify({ token: tokenOf(user), user }));
    this.store.set(HINT, serializeBiometricAccountHint(hint));
  }
  // settings.tsx toggleBiometric(false) → clearBiometricLogin()
  clearBiometric(): void {
    this.store.delete(VAULT);
    this.store.delete(HINT);
  }
  // AuthContext.login(): saveSession → reconcileBiometricLogin → bindAccount
  private login(user: U, token: string): string {
    this.store.set(TOKEN, token);
    this.store.set(USER, JSON.stringify(user));
    const action = reconcileBiometricOwner(parseStoredVault(this.store.get(VAULT) ?? null), user);
    if (action.kind === "none") this.store.delete(HINT);
    else if (action.kind === "keep") this.store.set(HINT, serializeBiometricAccountHint(action.hint));
    else this.clearBiometric();
    this.settings = bindSettingsToAccount(this.settings, accountOwnerKey(user));
    this.session = user;
    return action.kind;
  }
  /** Successful password (or password + MFA) login: the server issued a session. */
  passwordLogin(user: U): string {
    return this.login(user, tokenOf(user));
  }
  /** Rejected password/MFA attempt: nothing after the request runs. */
  failedLogin(_user: U): void {
    /* login() is never reached */
  }
  // AuthContext.logout(): clearSession → bindAccount(null) (react-query cleared too)
  logout(): void {
    this.store.delete(TOKEN);
    this.store.delete(USER);
    this.settings = bindSettingsToAccount(this.settings, null);
    this.session = null;
  }
  // app/login.tsx mount: hint record only (+ device support)
  loginScreen(): { visible: boolean; label: string | null; destination: ReturnType<typeof parseBiometricAccountHint> } {
    const destination = this.supported ? parseBiometricAccountHint(this.store.get(HINT) ?? null) : null;
    const label = destination
      ? interpolate(EN.auth.signInWithAs, { method: METHOD, account: destination.emailHint })
      : null;
    return { visible: destination !== null, label, destination };
  }
  // app/login.tsx handleBiometricLogin after the biometric prompt succeeded
  biometricSignIn(): "login" | "invalidate" {
    const { destination } = this.loginScreen();
    if (!destination) throw new Error("no biometric action is offered");
    const target = biometricSignInTarget(parseStoredVault(this.store.get(VAULT) ?? null), destination);
    if (target.kind !== "login") {
      this.clearBiometric();
      return "invalidate";
    }
    this.login(target.user as U, target.token);
    return "login";
  }
  hasVault(): boolean {
    return this.store.has(VAULT);
  }
  hasHint(): boolean {
    return this.store.has(HINT);
  }
  vaultOwner(): string | null | undefined {
    const v = parseStoredVault(this.store.get(VAULT) ?? null);
    return v.present ? v.owner : undefined;
  }
  sessionOwner(): string | null {
    return accountOwnerKey(this.session);
  }
}

function deviceWithARemembered(): Device {
  const d = new Device();
  d.passwordLogin(A);
  d.enableBiometric();
  d.logout();
  return d;
}

describe("biometric remembered account — RED proof of the shipped (c85f729) behaviour", () => {
  it("1. old semantics: B's password login leaves A's vault; the action is generic and opens A", () => {
    // Exactly what shipped: the vault was the only record, login() never
    // looked at it, and the button read "Sign in with {{method}}".
    const store = new Map<string, string>();
    store.set(VAULT, JSON.stringify({ token: tokenOf(A), user: A })); // A enables
    store.delete(TOKEN); // A logs out (clearSession only)
    store.set(TOKEN, tokenOf(B)); // B password-signs-in (saveSession only)
    store.delete(TOKEN); // B logs out
    const oldVault = JSON.parse(store.get(VAULT)!) as { token: string; user: U };
    const oldBioReady = true && !!oldVault;
    const oldLabel = interpolate(EN.auth.signInWith, { method: METHOD });
    expect(oldBioReady).toBe(true);
    expect(oldLabel).not.toMatch(/@|\*\*\*/); // nobody is named
    expect(accountOwnerKey(oldVault.user)).toBe(accountOwnerKey(A)); // ...but it opens A
    expect(accountOwnerKey(oldVault.user)).not.toBe(accountOwnerKey(B));
    // The corrected model, given that same stored state: no destination record
    // → nothing is offered, and B's login would have cleared A's vault.
    expect(parseBiometricAccountHint(null)).toBeNull();
    expect(reconcileBiometricOwner(parseStoredVault(store.get(VAULT)!), B)).toEqual({ kind: "clear" });
  });
});

describe("biometric remembered account — ownership", () => {
  it("2. successful password login as the SAME account preserves A's vault and destination", () => {
    const d = deviceWithARemembered();
    expect(d.passwordLogin(A)).toBe("keep");
    expect(d.hasVault()).toBe(true);
    expect(d.vaultOwner()).toBe(accountOwnerKey(A));
    expect(d.loginScreen().destination?.owner).toBe(accountOwnerKey(A));
  });

  it("3. successful password/MFA login as a DIFFERENT account clears A's vault and destination, and does not enrol B", () => {
    const d = deviceWithARemembered();
    expect(d.passwordLogin(B)).toBe("clear");
    expect(d.hasVault()).toBe(false);
    expect(d.hasHint()).toBe(false);
    d.logout();
    expect(d.loginScreen().visible).toBe(false);
  });

  it("4. a FAILED login attempt for B does not touch A's vault or destination", () => {
    const d = deviceWithARemembered();
    const before = [d.store.get(VAULT), d.store.get(HINT)];
    d.failedLogin(B);
    expect([d.store.get(VAULT), d.store.get(HINT)]).toEqual(before);
    expect(d.loginScreen().destination?.owner).toBe(accountOwnerKey(A));
  });

  it("5. equality is the stable user id + company id, never the e-mail", () => {
    const sameEmailOtherUser: U = { ...B, email: A.email };
    expect(reconcileBiometricOwner(parseStoredVault(JSON.stringify({ token: tokenOf(A), user: A })), sameEmailOtherUser)).toEqual({ kind: "clear" });
    const renamedA: U = { ...A, email: "renamed.alpha@tenant-a.example" };
    const kept = reconcileBiometricOwner(parseStoredVault(JSON.stringify({ token: tokenOf(A), user: A })), renamedA);
    expect(kept.kind).toBe("keep");
    expect(kept.kind === "keep" && kept.hint).toEqual({ owner: accountOwnerKey(A), emailHint: "r***@tenant-a.example" });
  });

  it("6. the same e-mail (even the same user id) in a different tenant is a different owner", () => {
    const otherTenant: U = { ...A, companyId: 9 };
    expect(ownerOfStoredUser(otherTenant)).not.toBe(ownerOfStoredUser(A));
    expect(reconcileBiometricOwner(parseStoredVault(JSON.stringify({ token: tokenOf(A), user: A })), otherTenant)).toEqual({ kind: "clear" });
    const d = deviceWithARemembered();
    expect(d.passwordLogin(otherTenant)).toBe("clear");
    expect(d.hasVault()).toBe(false);
  });

  it("7. logout alone preserves the remembered biometric login and its destination", () => {
    const d = deviceWithARemembered(); // ends logged out
    expect(d.session).toBeNull();
    expect(d.store.has(TOKEN)).toBe(false);
    expect(d.hasVault()).toBe(true);
    expect(d.loginScreen().visible).toBe(true);
  });
});

describe("biometric remembered account — destination clarity", () => {
  it("8. the biometric button names the remembered account, masked", () => {
    const d = deviceWithARemembered();
    expect(d.loginScreen().label).toBe(`Sign in with ${METHOD} as a***@tenant-a.example`);
    expect(AR.auth.signInWithAs).toMatch(/\{\{method\}\}/);
    expect(AR.auth.signInWithAs).toMatch(/\{\{account\}\}/);
  });

  it("9. masking: normal, short, no domain, missing and malformed input", () => {
    expect(maskEmail("daniel@example.com")).toBe("d***@example.com");
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("***@example.com"); // 1 char = whole local part → hidden
    expect(maskEmail("@example.com")).toBe("***@example.com");
    expect(maskEmail("nodomain")).toBe("n***");
    expect(maskEmail("  Zed.Q@Example.ORG  ")).toBe("Z***@Example.ORG");
    expect(maskEmail("émile@example.fr")).toBe("é***@example.fr");
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("   ")).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(42)).toBeNull();
    expect(biometricAccountHint({ ...A, email: "" })).toBeNull(); // no safe hint → nothing offered
    expect(biometricAccountHint({ ...A, id: 0 })).toBeNull(); // no stable identity → nothing offered
  });

  it("10. neither the destination record nor the label carries a token, password, raw e-mail or ids", () => {
    const d = deviceWithARemembered();
    const record = d.store.get(HINT)!;
    expect(Object.keys(JSON.parse(record) as object).sort()).toEqual(["emailHint", "owner"]);
    for (const forbidden of ["token", "password", "alpha.person", tokenOf(A), "SYNTHETIC"]) {
      expect(record).not.toContain(forbidden);
    }
    const label = d.loginScreen().label!;
    for (const forbidden of [tokenOf(A), "alpha.person", String(A.id), String(A.companyId), accountOwnerKey(A)!, "token"]) {
      expect(label).not.toContain(forbidden);
    }
  });
});

describe("biometric remembered account — legacy and malformed state fails safe", () => {
  it("11. a vault from the old build (no destination record) is not offered; it is attributed only by the owner's own password login", () => {
    const d = new Device();
    d.store.set(VAULT, JSON.stringify({ token: tokenOf(A), user: A })); // old build enrolled A
    expect(d.loginScreen().visible).toBe(false); // no generic destination
    // typing B's e-mail / remembering it proves nothing
    d.store.set(REMEMBER, B.email);
    expect(d.loginScreen().visible).toBe(false);
    // A proves ownership with a password login → migrated, kept, now clearly labelled
    expect(d.passwordLogin(A)).toBe("keep");
    d.logout();
    expect(d.loginScreen().label).toBe(`Sign in with ${METHOD} as a***@tenant-a.example`);
    // whereas a legacy vault met by B's password login is cleared
    const e = new Device();
    e.store.set(VAULT, JSON.stringify({ token: tokenOf(A), user: A }));
    expect(e.passwordLogin(B)).toBe("clear");
    expect(e.hasVault()).toBe(false);
  });

  it("12. malformed destination records are ignored; a record/vault mismatch invalidates both", () => {
    for (const bad of [
      "not json",
      "[]",
      "42",
      JSON.stringify({ owner: "x@y", emailHint: "a***@x" }),
      JSON.stringify({ owner: accountOwnerKey(A) }),
      JSON.stringify({ owner: accountOwnerKey(A), emailHint: A.email }), // unmasked → never shown
      JSON.stringify({ owner: accountOwnerKey(A), emailHint: "a*** @x" }),
      JSON.stringify({ owner: 11, emailHint: "a***@x" }),
    ]) {
      expect(parseBiometricAccountHint(bad), bad).toBeNull();
    }
    // record says A, vault holds B → nothing is opened, both are cleared
    const d = new Device();
    d.store.set(HINT, serializeBiometricAccountHint(biometricAccountHint(A)!));
    d.store.set(VAULT, JSON.stringify({ token: tokenOf(B), user: B }));
    expect(d.loginScreen().visible).toBe(true);
    expect(d.biometricSignIn()).toBe("invalidate");
    expect(d.session).toBeNull();
    expect(d.hasVault()).toBe(false);
    expect(d.hasHint()).toBe(false);
    // record present, vault malformed / missing → same outcome
    const e = new Device();
    e.store.set(HINT, serializeBiometricAccountHint(biometricAccountHint(A)!));
    e.store.set(VAULT, "{not json");
    expect(e.biometricSignIn()).toBe("invalidate");
    expect(e.hasHint()).toBe(false);
    const f = new Device();
    f.store.set(HINT, serializeBiometricAccountHint(biometricAccountHint(A)!));
    expect(f.biometricSignIn()).toBe("invalidate");
    expect(f.hasHint()).toBe(false);
    // a malformed vault is never kept past the next successful login
    expect(reconcileBiometricOwner(parseStoredVault("{not json"), A)).toEqual({ kind: "clear" });
    expect(reconcileBiometricOwner(parseStoredVault(JSON.stringify({ user: A })), A)).toEqual({ kind: "clear" }); // no token
    expect(reconcileBiometricOwner(parseStoredVault(JSON.stringify({ token: tokenOf(A) })), A)).toEqual({ kind: "clear" }); // no user
    expect(reconcileBiometricOwner(parseStoredVault(null), A)).toEqual({ kind: "none" });
  });
});

describe("biometric sign-in goes through the normal account-binding path", () => {
  it("13. a valid A vault still signs in as A", () => {
    const d = deviceWithARemembered();
    expect(d.biometricSignIn()).toBe("login");
    expect(d.sessionOwner()).toBe(accountOwnerKey(A));
    expect(d.store.get(TOKEN)).toBe(tokenOf(A));
    expect(d.hasVault()).toBe(true); // reconciled as "keep"
  });

  it("14. biometric success runs the same login() as a password login (session, reconcile, binding)", () => {
    const viaBiometric = deviceWithARemembered();
    viaBiometric.biometricSignIn();
    const viaPassword = deviceWithARemembered();
    viaPassword.passwordLogin(A);
    expect(viaBiometric.settings).toEqual(viaPassword.settings);
    expect(viaBiometric.sessionOwner()).toBe(viaPassword.sessionOwner());
    expect(viaBiometric.store.get(USER)).toBe(viaPassword.store.get(USER));
  });

  it("15. account-scoped settings resolve to A's owner, not to tenant state another account left behind", () => {
    const d = deviceWithARemembered();
    // tenant state another account left in storage
    d.settings = selectActiveEvent(d.settings, 77, "B's event", accountOwnerKey(B));
    expect(d.biometricSignIn()).toBe("login");
    expect(d.settings.scopeOwner).toBe(accountOwnerKey(A));
    expect(d.settings.activeEventId).toBeNull();
    expect(visibleSettings(d.settings, accountOwnerKey(A)).activeEventId).toBeNull();
  });

  it("16. the offline queue owner after biometric sign-in is A's tenant key", () => {
    const d = deviceWithARemembered();
    d.biometricSignIn();
    const owner = queueOwnerKey(d.session);
    expect(owner).toBe(`${A.id}@${A.companyId}`);
    const items = enqueueItem([], { kind: "contact", label: "x", source: "manual" }, owner, 1, "q1")!;
    expect(items[0].owner).toBe(owner);
    expect(visibleQueue(items, queueOwnerKey(B))).toEqual([]);
  });

  it("17. the own-card cache owner after biometric sign-in is A's tenant key", () => {
    const d = deviceWithARemembered();
    d.biometricSignIn();
    const owner = queueOwnerKey(d.session);
    const card = { id: 5, userId: A.id, companyId: A.companyId, publicToken: "pt", templateId: "classic", fieldVisibility: {} } as unknown as BusinessCard;
    const stored = parseStoredCardCache(serializeCardCache(owner, card));
    expect(stored.kind).toBe("owned");
    const cache = stored.kind === "owned" ? stored.cache : null;
    expect(cache?.owner).toBe(`${A.id}@${A.companyId}`);
    expect(visibleCachedCard(cache, owner)?.id).toBe(5);
    expect(visibleCachedCard(cache, queueOwnerKey(B))).toBeNull();
  });
});

describe("biometric remembered account — enrolment lifecycle", () => {
  it("18. enabling biometrics under B replaces A's vault and destination with B's", () => {
    const d = deviceWithARemembered();
    d.passwordLogin(B);
    d.enableBiometric();
    d.logout();
    expect(d.vaultOwner()).toBe(accountOwnerKey(B));
    expect(d.loginScreen().label).toBe(`Sign in with ${METHOD} as b***@tenant-b.example`);
    expect(d.store.get(HINT)).not.toContain("tenant-a");
    expect(d.biometricSignIn()).toBe("login");
    expect(d.sessionOwner()).toBe(accountOwnerKey(B));
  });

  it("19. the Settings clear removes the vault AND the destination record", () => {
    const d = new Device();
    d.passwordLogin(A);
    d.enableBiometric();
    expect(d.hasVault() && d.hasHint()).toBe(true);
    d.clearBiometric();
    expect(d.hasVault()).toBe(false);
    expect(d.hasHint()).toBe(false);
    d.logout();
    expect(d.loginScreen().visible).toBe(false);
  });

  it("20. the remembered e-mail is independent and never decides vault ownership", () => {
    const d = deviceWithARemembered();
    d.store.set(REMEMBER, B.email); // the form remembers B
    expect(d.loginScreen().label).toBe(`Sign in with ${METHOD} as a***@tenant-a.example`); // the vault still names A
    expect(d.vaultOwner()).toBe(accountOwnerKey(A));
    d.failedLogin(B); // typed B, rejected → A untouched
    expect(d.vaultOwner()).toBe(accountOwnerKey(A));
    expect(d.store.get(REMEMBER)).toBe(B.email);
    d.passwordLogin(B); // only a SUCCESSFUL B login invalidates A
    expect(d.hasVault()).toBe(false);
    expect(d.store.get(REMEMBER)).toBe(B.email); // and the remembered e-mail is not part of that
  });
});

describe("wiring: the app drives the stores exactly like the Device above", () => {
  const storage = read("lib/biometric.ts");
  const auth = read("contexts/AuthContext.tsx");
  const login = read("app/login.tsx");
  const settings = read("app/settings.tsx");

  it("lib/biometric.ts delegates every decision to the pure model and never exposes the raw vault", () => {
    for (const fn of ["reconcileBiometricOwner(", "biometricSignInTarget(", "parseBiometricAccountHint(", "biometricAccountHint(", "parseStoredVault("]) {
      expect(storage).toContain(fn);
    }
    expect(storage).not.toMatch(/export (async )?function readBiometricVault/);
  });

  it("AuthContext.login() reconciles the vault right after the session is saved — the one path every login takes", () => {
    const body = auth.slice(auth.indexOf("const login = useCallback("), auth.indexOf("const logout = useCallback("));
    expect(body.indexOf("saveSession(")).toBeGreaterThan(-1);
    expect(body.indexOf("reconcileBiometricLogin(")).toBeGreaterThan(body.indexOf("saveSession("));
    expect(body.indexOf("bindAccount(")).toBeGreaterThan(body.indexOf("reconcileBiometricLogin("));
    const logoutBody = auth.slice(auth.indexOf("const logout = useCallback("), auth.indexOf("const updateUser"));
    expect(logoutBody).not.toMatch(/[Bb]iometric/); // logout leaves the vault alone
  });

  it("the login screen draws the button from the destination record only and names the account", () => {
    const mount = login.slice(login.indexOf("useEffect("), login.indexOf("async function persistRemember"));
    expect(mount).toContain("readBiometricAccountHint()");
    expect(mount).not.toMatch(/readBiometricSignIn|Vault/);
    expect(login).toMatch(/t\("auth\.signInWithAs", \{ method: bioLabel, account: bioDestination\.emailHint \}\)/);
    expect(login).toMatch(/\{bioDestination \? \(/); // no destination → no button
    expect(login).not.toMatch(/t\("auth\.signInWith",/); // the generic label is gone
    const handlerStart = login.indexOf("async function handleBiometricLogin");
    const handler = login.slice(handlerStart, login.indexOf("\n  return (", handlerStart));
    expect(handler.indexOf("readBiometricSignIn(bioDestination)")).toBeGreaterThan(handler.indexOf("authenticateBiometric("));
    expect(handler).toContain("clearBiometricLogin()");
    expect(handler).toContain("await login(target.token, target.user)"); // AuthContext.login, no shortcut
  });

  it("the Settings toggle enrols and clears vault + destination together", () => {
    expect(settings).toContain("await saveBiometricLogin(token, user)");
    expect(settings).toContain("await clearBiometricLogin()");
    expect(settings).not.toMatch(/saveBiometricVault|clearBiometricVault/);
  });

  it("both locales define the labelled sign-in string with method and account", () => {
    for (const s of [EN.auth.signInWithAs, AR.auth.signInWithAs]) {
      expect(s).toMatch(/\{\{method\}\}/);
      expect(s).toMatch(/\{\{account\}\}/);
    }
  });
});
