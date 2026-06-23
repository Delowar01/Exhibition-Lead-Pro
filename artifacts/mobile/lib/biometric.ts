import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

import type { User } from "@workspace/api-client-react";

import { deleteSecureItem, getSecureItem, setSecureItem } from "./secure-prefs";

// Biometric "quick sign-in" vault.
//
// When the user enables biometric sign-in (while already authenticated) we
// persist the current session token + user into the hardware-backed secure
// store. On the login screen, if a vault exists and the device supports
// biometrics, the user can re-authenticate with Face ID / fingerprint instead
// of typing their password. A stored JWT (not a password) is kept; if it has
// since expired the API will reject it and the user simply signs in manually.
//
// All biometric APIs are native-only — every entry point guards on
// Platform.OS !== "web".

const VAULT_KEY = "csp_biometric_vault";

export interface BiometricVault {
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

export async function saveBiometricVault(
  token: string,
  user: User,
): Promise<void> {
  await setSecureItem(VAULT_KEY, JSON.stringify({ token, user }));
}

export async function readBiometricVault(): Promise<BiometricVault | null> {
  const raw = await getSecureItem(VAULT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BiometricVault;
  } catch {
    return null;
  }
}

export async function clearBiometricVault(): Promise<void> {
  await deleteSecureItem(VAULT_KEY);
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
