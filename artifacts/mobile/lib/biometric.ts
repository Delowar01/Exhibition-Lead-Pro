import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

import type { User } from "@workspace/api-client-react";

import {
  type BiometricAccountHint,
  type BiometricReconcileAction,
  biometricAccountHint,
  biometricSignInTarget,
  parseBiometricAccountHint,
  parseStoredVault,
  reconcileBiometricOwner,
  serializeBiometricAccountHint,
} from "./biometric-account-model";
import { deleteSecureItem, getSecureItem, setSecureItem } from "./secure-prefs";

// Biometric "quick sign-in" vault.
//
// When the user enables biometric sign-in (while already authenticated) we
// persist the current session token + user into the hardware-backed secure
// store. On the login screen, if the device supports biometrics and the
// remembered DESTINATION is known, the user can re-authenticate with Face ID /
// fingerprint instead of typing their password. A stored JWT (not a password)
// is kept; if it has since expired the API will reject it and the user simply
// signs in manually.
//
// B25 Stage 1 — remembered-account clarity. The vault remembers exactly ONE
// account and survives logout on purpose, so the login screen must say which
// account it opens. That destination is a separate NON-SECRET record
// (`csp_biometric_account`: stable `<userId>@<companyId>` + masked e-mail) that
// is written and cleared together with the vault; the screen reads only that
// record to draw the button and reads the vault only after a successful
// biometric prompt. A successful login as a DIFFERENT account clears the
// remembered one (rules: lib/biometric-account-model.ts).
//
// All biometric APIs are native-only — every entry point guards on
// Platform.OS !== "web".

const VAULT_KEY = "csp_biometric_vault";
const ACCOUNT_KEY = "csp_biometric_account";

export type { BiometricAccountHint } from "./biometric-account-model";

export interface BiometricSignIn {
  owner: string;
  token: string;
  user: User;
}

export async function isBiometricSupported(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}

export async function getBiometricLabel(): Promise<string> {
  if (Platform.OS === "web") return "Biometrics";
  try {
    const types =
      await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (
      types.includes(
        LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
      )
    ) {
      return "Face ID";
    }
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      return "Fingerprint";
    }
  } catch {
    // fall through
  }
  return "Biometrics";
}

export async function authenticateBiometric(
  promptMessage: string,
): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: "Use passcode",
      cancelLabel: "Cancel",
    });
    return res.success;
  } catch {
    return false;
  }
}

/**
 * Enable biometric sign-in for the authenticated account: the secret vault plus
 * its non-secret destination. Replaces whatever account was remembered before.
 */
export async function saveBiometricLogin(
  token: string,
  user: User,
): Promise<void> {
  const hint = biometricAccountHint(user);
  if (!hint) throw new Error("Account has no stable identity for biometric sign-in");
  await setSecureItem(VAULT_KEY, JSON.stringify({ token, user }));
  await setSecureItem(ACCOUNT_KEY, serializeBiometricAccountHint(hint));
}

/**
 * The remembered destination the login screen may offer (null = none, legacy
 * vault without a record, or malformed record → nothing is offered). This
 * never touches the secret vault.
 */
export async function readBiometricAccountHint(): Promise<BiometricAccountHint | null> {
  return parseBiometricAccountHint(await getSecureItem(ACCOUNT_KEY));
}

/**
 * Only after a successful biometric prompt: the vault session, provided the
 * vault is the advertised destination. Null means the vault is missing,
 * unidentifiable or not that account — the caller clears the enrolment.
 */
export async function readBiometricSignIn(
  destination: BiometricAccountHint | null,
): Promise<BiometricSignIn | null> {
  const target = biometricSignInTarget(parseStoredVault(await getSecureItem(VAULT_KEY)), destination);
  if (target.kind !== "login") return null;
  // The vault is written from a `User` by saveBiometricLogin; its identity was
  // validated by the model, the remaining fields are the server's user record.
  return { owner: target.owner, token: target.token, user: target.user as User };
}

/** Forget the remembered account: secret vault AND its destination record. */
export async function clearBiometricLogin(): Promise<void> {
  await deleteSecureItem(VAULT_KEY);
  await deleteSecureItem(ACCOUNT_KEY);
}

/**
 * After a SUCCESSFUL login (password, MFA or biometric): keep the vault when
 * it belongs to the account that just authenticated — refreshing its
 * destination record, which also migrates a legacy vault — and clear it when
 * a different or unidentifiable account is remembered. Never called for a
 * failed attempt or a logout.
 */
export async function reconcileBiometricLogin(
  user: User,
): Promise<BiometricReconcileAction["kind"]> {
  const action = reconcileBiometricOwner(parseStoredVault(await getSecureItem(VAULT_KEY)), user);
  if (action.kind === "none") await deleteSecureItem(ACCOUNT_KEY);
  else if (action.kind === "keep") await setSecureItem(ACCOUNT_KEY, serializeBiometricAccountHint(action.hint));
  else await clearBiometricLogin();
  return action.kind;
}

// ---------------------------------------------------------------------------
// PIN fallback storage
//
// A 6-digit PIN stored in the hardware-backed secure store alongside (or
// instead of) the biometric vault. The PIN itself is stored directly — the
// SecureStore backend is AES-256-GCM encrypted and hardware-attested, so
// storing the plain PIN value there is equivalent in security to storing a
// hashed value (the TEE gates both equally).
// ---------------------------------------------------------------------------

/** Required number of digits in the App PIN. */
export const PIN_LENGTH = 6;

/** Max consecutive wrong PIN attempts before a temporary lockout kicks in. */
export const MAX_PIN_ATTEMPTS = 5;

/** Duration of the temporary PIN lockout after MAX_PIN_ATTEMPTS failures. */
export const PIN_LOCKOUT_MS = 30_000;

const PIN_KEY = "csp_app_lock_pin";

export async function savePin(pin: string): Promise<void> {
  await setSecureItem(PIN_KEY, pin);
}

export async function verifyPin(pin: string): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const stored = await getSecureItem(PIN_KEY);
  return stored !== null && stored === pin;
}

export async function clearPin(): Promise<void> {
  await deleteSecureItem(PIN_KEY);
  await clearPinLockState();
}

export async function hasPinSet(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const stored = await getSecureItem(PIN_KEY);
  return stored !== null && stored.length > 0;
}

// ---------------------------------------------------------------------------
// Brute-force lockout state
//
// After MAX_PIN_ATTEMPTS consecutive wrong PINs we lock PIN entry for
// PIN_LOCKOUT_MS. The state is persisted so quitting + relaunching the app
// cannot reset the attempt counter or bypass an active lockout. Biometrics
// remain available throughout — this only throttles PIN guessing. The lockout
// is always temporary; it never permanently locks the app or the account.
// ---------------------------------------------------------------------------

const PIN_LOCK_STATE_KEY = "csp_app_lock_pin_state";

export interface PinLockState {
  /** Consecutive wrong attempts since the last success / lockout reset. */
  failedAttempts: number;
  /** Epoch ms until which PIN entry is locked, or null if not locked. */
  lockedUntil: number | null;
}

const EMPTY_PIN_LOCK_STATE: PinLockState = {
  failedAttempts: 0,
  lockedUntil: null,
};

export async function readPinLockState(): Promise<PinLockState> {
  const raw = await getSecureItem(PIN_LOCK_STATE_KEY);
  if (!raw) return { ...EMPTY_PIN_LOCK_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<PinLockState>;
    return {
      failedAttempts:
        typeof parsed.failedAttempts === "number" ? parsed.failedAttempts : 0,
      lockedUntil:
        typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : null,
    };
  } catch {
    return { ...EMPTY_PIN_LOCK_STATE };
  }
}

export async function writePinLockState(state: PinLockState): Promise<void> {
  await setSecureItem(PIN_LOCK_STATE_KEY, JSON.stringify(state));
}

export async function clearPinLockState(): Promise<void> {
  await deleteSecureItem(PIN_LOCK_STATE_KEY);
}
