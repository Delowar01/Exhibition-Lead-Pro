import { Feather } from "@/components/icons";
import { PinPad } from "@/components/PinPad";
import { Image } from "expo-image";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/components/ui";
import { useAppLock } from "@/contexts/AppLockContext";
import { useAuth } from "@/contexts/AuthContext";
import { getBiometricLabel } from "@/lib/biometric";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

export function AppLockOverlay() {
  const { isLocked, triggerUnlock, pinFallbackAvailable, submitPin } = useAppLock();
  const { isAuthenticated } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useLocale();

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [bioLabel, setBioLabel] = useState(t("auth.biometrics"));

  // PIN mode state
  const [pinMode, setPinMode] = useState(false);
  const [pinResetSignal, setPinResetSignal] = useState(0);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web") {
      getBiometricLabel().then(setBioLabel).catch(() => {});
    }
  }, []);

  // Fire the biometric prompt automatically as soon as the overlay becomes
  // visible (but only in biometric mode, not PIN mode).
  useEffect(() => {
    if (!isLocked || !isAuthenticated) return;
    if (pinMode) return;
    void attemptUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked, isAuthenticated]);

  // Reset PIN mode when the overlay is dismissed.
  useEffect(() => {
    if (!isLocked) {
      setPinMode(false);
      setFailed(false);
      setPinError(null);
    }
  }, [isLocked]);

  // Intercept Android hardware back button while locked — return true to
  // swallow the event so the user cannot back out of the lock screen.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!isLocked || !isAuthenticated) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [isLocked, isAuthenticated]);

  async function attemptUnlock() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const ok = await triggerUnlock(
        t("appLock.promptMessage", { defaultValue: "Unlock Card Scanner Pro" }),
      );
      if (!ok) {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handlePinComplete(pin: string) {
    if (pinBusy) return;
    setPinBusy(true);
    setPinError(null);
    try {
      const ok = await submitPin(pin);
      if (!ok) {
        setPinError(t("appLock.wrongPin"));
        setPinResetSignal((s) => s + 1);
      }
    } finally {
      setPinBusy(false);
    }
  }

  function switchToPinMode() {
    setPinMode(true);
    setFailed(false);
    setPinError(null);
  }

  function switchToBioMode() {
    setPinMode(false);
    setFailed(false);
    setPinError(null);
    // Trigger bio prompt immediately on switch.
    void attemptUnlock();
  }

  // Only show on native when the user is authenticated and the app is locked.
  // Web degrades gracefully — no overlay, no prompt (biometric UI is hidden
  // on web anyway, so this state is unreachable in practice).
  if (!isLocked || !isAuthenticated || Platform.OS === "web") {
    return null;
  }

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        styles.container,
        {
          backgroundColor: colors.dark,
          paddingTop: insets.top + 40,
          paddingBottom: insets.bottom + 32,
        },
      ]}
    >
      <View style={styles.inner} pointerEvents="box-none">
        <View style={[styles.logoBadge, { borderRadius: colors.radius + 4 }]}>
          <Image
            source={require("@/assets/images/icon.png")}
            style={styles.logoImg}
            contentFit="cover"
          />
        </View>

        <Text style={styles.appName}>Card Scanner Pro</Text>

        {/* ── PIN entry mode ── */}
        {pinMode ? (
          <>
            <Text style={styles.lockedLabel}>{t("appLock.enterPin")}</Text>
            <PinPad
              onComplete={handlePinComplete}
              resetSignal={pinResetSignal}
              disabled={pinBusy}
              subtitle={t("appLock.pinSubtitle")}
              error={pinError ?? undefined}
            />
            {/* "Use biometrics" link */}
            <Pressable
              onPress={switchToBioMode}
              style={({ pressed }) => [styles.altLink, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Feather name="cpu" size={14} color="rgba(255,255,255,0.55)" />
              <Text style={styles.altLinkText}>{t("appLock.useBiometrics")}</Text>
            </Pressable>
          </>
        ) : (
          /* ── Biometric mode ── */
          <>
            <Text style={styles.lockedLabel}>{t("appLock.locked")}</Text>

            {busy ? (
              <ActivityIndicator
                color={colors.primary}
                size="large"
                style={styles.spinner}
              />
            ) : (
              <Pressable
                onPress={attemptUnlock}
                style={({ pressed }) => [
                  styles.unlockBtn,
                  {
                    backgroundColor: colors.primary,
                    borderRadius: colors.radius + 4,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Feather
                  name={bioLabel === "Face ID" ? "user" : "unlock"}
                  size={20}
                  color="#FFFFFF"
                />
                <Text style={styles.unlockText}>
                  {failed ? t("common.retry") : t("appLock.tapToUnlock")}
                </Text>
              </Pressable>
            )}

            {failed && !busy ? (
              <Text style={[styles.failedText, { color: colors.mutedForeground }]}>
                {t("appLock.authFailed")}
              </Text>
            ) : null}

            {/* "Use PIN instead" — shown after first bio failure if PIN is set */}
            {failed && !busy && pinFallbackAvailable ? (
              <Pressable
                onPress={switchToPinMode}
                style={({ pressed }) => [styles.altLink, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Feather name="hash" size={14} color="rgba(255,255,255,0.55)" />
                <Text style={styles.altLinkText}>{t("appLock.usePinInstead")}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 9999,
    elevation: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 32,
    width: "100%",
  },
  logoBadge: {
    width: 80,
    height: 80,
    overflow: "hidden",
    marginBottom: 8,
  },
  logoImg: {
    width: "100%",
    height: "100%",
  },
  appName: {
    color: "#FFFFFF",
    fontSize: 22,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  lockedLabel: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 15,
    fontFamily: FONT.medium,
    textAlign: "center",
    marginBottom: 8,
  },
  spinner: {
    marginTop: 8,
  },
  unlockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 28,
    paddingVertical: 14,
    marginTop: 8,
  },
  unlockText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  failedText: {
    fontSize: 13,
    fontFamily: FONT.medium,
    textAlign: "center",
    marginTop: 4,
  },
  altLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  altLinkText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontFamily: FONT.medium,
  },
});
