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
