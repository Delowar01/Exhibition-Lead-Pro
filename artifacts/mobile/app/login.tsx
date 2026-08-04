import { Feather } from "@/components/icons";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError, useLogin, useMfaVerifyLogin } from "@workspace/api-client-react";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { FONT, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import {
  authenticateBiometric,
  getBiometricLabel,
  isBiometricSupported,
  readBiometricVault,
} from "@/lib/biometric";
import {
  deleteSecureItem,
  getSecureItem,
  setSecureItem,
} from "@/lib/secure-prefs";

const DEMO_ACCOUNTS = [
  { label: "TechCorp Admin", email: "admin@techcorp.com" },
  { label: "Nexus Admin", email: "admin@nexussys.io" },
];

const REMEMBER_KEY = "csp_remember_email";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login } = useAuth();
  const loginMutation = useLogin();
  const mfaMutation = useMfaVerifyLogin();
  const { t, isRTL, textAlign } = useLocale();

  const [email, setEmail] = useState("admin@techcorp.com");
  const [password, setPassword] = useState("Admin123!");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  // MFA challenge step: set when the server answers a password-verified login
  // with { mfaRequired, mfaToken } instead of an operational token.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [bioReady, setBioReady] = useState(false);
  const [bioLabel, setBioLabel] = useState(t("auth.biometrics"));
  const [bioBusy, setBioBusy] = useState(false);

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const remembered = await getSecureItem(REMEMBER_KEY);
      if (mounted && remembered) {
        setEmail(remembered);
        setRememberMe(true);
      }
      const [supported, vault, label] = await Promise.all([
        isBiometricSupported(),
        readBiometricVault(),
        getBiometricLabel(),
      ]);
      if (mounted) {
        setBioReady(supported && !!vault);
        setBioLabel(label);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function persistRemember(emailValue: string) {
    if (rememberMe) {
      await setSecureItem(REMEMBER_KEY, emailValue);
    } else {
      await deleteSecureItem(REMEMBER_KEY);
    }
  }

  async function handleLogin(emailValue: string, passwordValue: string) {
    setError(null);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    try {
      const res = await loginMutation.mutateAsync({
        data: { email: emailValue, password: passwordValue },
      });
      if (res.mfaRequired && res.mfaToken) {
        if (res.mfaEnrollmentRequired) {
          // Company policy mandates MFA but this account has not enrolled.
          // Enrollment is a web/admin flow — no mobile MFA administration.
          setError(t("auth.mfaEnrollRequired"));
          if (Platform.OS !== "web") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
          return;
        }
        setPendingEmail(emailValue);
        setMfaCode("");
        setMfaToken(res.mfaToken);
        return;
      }
      if (!res.token || !res.user) {
        setError(t("auth.signInFailed"));
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
        return;
      }
      await persistRemember(emailValue);
      await login(res.token, res.user);
    } catch (err) {
      let message: string;
      if (err instanceof ApiError) {
        if (err.status === 401) {
          message = t("auth.invalidCredentials");
        } else if (err.status === 403) {
          message = t("auth.contactAdmin");
        } else if (err.status >= 500) {
          message = t("errors.generic");
        } else {
          message = t("auth.signInFailed");
        }
      } else {
        message = t("errors.network");
      }
      setError(message);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    }
  }

  async function handleMfaVerify() {
    if (!mfaToken || !mfaCode.trim()) return;
    setError(null);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    try {
      const res = await mfaMutation.mutateAsync({
        data: { mfaToken, code: mfaCode.trim(), rememberMe },
      });
      if (!res.token || !res.user) {
        setError(t("auth.signInFailed"));
        return;
      }
      await persistRemember(pendingEmail);
      await login(res.token, res.user);
    } catch (err) {
      let message: string;
      if (err instanceof ApiError) {
        if (err.status === 401) {
          message = t("auth.mfaInvalidOrExpired");
        } else if (err.status >= 500) {
          message = t("errors.generic");
        } else {
          message = t("auth.signInFailed");
        }
      } else {
        message = t("errors.network");
      }
      setError(message);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    }
  }

  function cancelMfa() {
    setMfaToken(null);
    setMfaCode("");
    setError(null);
  }

  async function handleBiometricLogin() {
    setError(null);
    setBioBusy(true);
    try {
      const ok = await authenticateBiometric(
        t("auth.signInWith", { method: bioLabel }),
      );
      if (!ok) return;
      const vault = await readBiometricVault();
      if (!vault) {
        setError(t("auth.signInFailed"));
        setBioReady(false);
        return;
      }
      await login(vault.token, vault.user);
    } catch {
      setError(t("auth.signInFailed"));
    } finally {
      setBioBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.dark }}>
      <LinearGradient
        colors={[colors.dark, "#241B2E", colors.primary + "33"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + webTopInset + 40,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={20}
      >
        <View style={[styles.brandRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <View style={[styles.logoBadge, { borderRadius: colors.radius + 4 }]}>
            <Image
              source={require("@/assets/images/icon.png")}
              style={styles.logoImg}
              contentFit="cover"
            />
          </View>
          <View>
            <Text style={[styles.brandTitle, { textAlign }]}>Card Scanner Pro</Text>
            <Text style={[styles.brandSub, { textAlign }]}>{t("login.tagline")}</Text>
          </View>
        </View>

        <View style={styles.heroBlock}>
          <Text style={[styles.heroTitle, { textAlign }]}>{t("login.heroTitle")}</Text>
          <Text style={[styles.heroText, { textAlign }]}>
            {t("login.heroText")}
          </Text>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderRadius: colors.radius + 8 },
          ]}
        >
          {mfaToken ? (
            <>
              <View style={{ alignItems: "center", marginBottom: 14 }}>
                <Feather name="shield" size={28} color={colors.primary} />
              </View>
              <Text
                style={[
                  styles.fieldLabel,
                  { color: colors.foreground, fontSize: 16, textAlign: "center" },
                ]}
              >
                {t("auth.mfaTitle")}
              </Text>
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontSize: 13,
                  fontFamily: FONT.regular,
                  textAlign: "center",
                  marginTop: 6,
                  marginBottom: 16,
                }}
              >
                {t("auth.mfaPrompt")}
              </Text>
              <View
                style={[
                  styles.inputRow,
                  {
                    borderColor: colors.border,
                    borderRadius: colors.radius,
                    flexDirection: isRTL ? "row-reverse" : "row",
                  },
                ]}
              >
                <Feather name="key" size={18} color={colors.mutedForeground} />
                <TextInput
                  value={mfaCode}
                  onChangeText={setMfaCode}
                  placeholder={t("auth.mfaCodePlaceholder")}
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  onSubmitEditing={handleMfaVerify}
                  style={[styles.input, { color: colors.foreground, textAlign }]}
                />
              </View>

              {error ? (
                <View style={[styles.errorRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  <Feather name="alert-circle" size={14} color={colors.destructive} />
                  <Text style={[styles.errorText, { color: colors.destructive, textAlign }]}>
                    {error}
                  </Text>
                </View>
              ) : null}

              <PrimaryButton
                label={t("auth.mfaVerify")}
                icon="check"
                onPress={handleMfaVerify}
                loading={mfaMutation.isPending}
                style={{ marginTop: 20 }}
              />
              <Pressable onPress={cancelMfa} hitSlop={8} style={{ marginTop: 14, alignSelf: "center" }}>
                <Text style={[styles.forgotText, { color: colors.primary, textAlign }]}>
                  {t("auth.backToLogin")}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("auth.email")}
          </Text>
          <View
            style={[
              styles.inputRow,
              {
                borderColor: colors.border,
                borderRadius: colors.radius,
                flexDirection: isRTL ? "row-reverse" : "row",
              },
            ]}
          >
            <Feather name="mail" size={18} color={colors.mutedForeground} />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={t("auth.emailPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              style={[styles.input, { color: colors.foreground, textAlign }]}
            />
          </View>

          <Text
            style={[
              styles.fieldLabel,
              { color: colors.mutedForeground, marginTop: 16, textAlign },
            ]}
          >
            {t("auth.password")}
          </Text>
          <View
            style={[
              styles.inputRow,
              {
                borderColor: colors.border,
                borderRadius: colors.radius,
                flexDirection: isRTL ? "row-reverse" : "row",
              },
            ]}
          >
            <Feather name="lock" size={18} color={colors.mutedForeground} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              style={[styles.input, { color: colors.foreground }]}
            />
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
            >
              <Feather
                name={showPassword ? "eye-off" : "eye"}
                size={18}
                color={colors.mutedForeground}
              />
            </Pressable>
          </View>

          <View style={[styles.optionsRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Pressable
              onPress={() => setRememberMe((v) => !v)}
              hitSlop={8}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: rememberMe }}
              accessibilityLabel={t("auth.rememberMe")}
              style={[styles.rememberRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
            >
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: rememberMe ? colors.primary : colors.border,
                    backgroundColor: rememberMe ? colors.primary : "transparent",
                    borderRadius: 5,
                  },
                ]}
              >
                {rememberMe ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
              </View>
              <Text style={[styles.rememberText, { color: colors.mutedForeground, textAlign }]}>
                {t("auth.rememberMe")}
              </Text>
            </Pressable>
            <Pressable onPress={() => router.push("/forgot-password")} hitSlop={8}>
              <Text style={[styles.forgotText, { color: colors.primary, textAlign }]}>
                {t("auth.forgotPassword")}
              </Text>
            </Pressable>
          </View>

          {error ? (
            <View style={[styles.errorRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive, textAlign }]}>
                {error}
              </Text>
            </View>
          ) : null}

          <PrimaryButton
            label={t("auth.signIn")}
            icon="arrow-right"
            onPress={() => handleLogin(email, password)}
            loading={loginMutation.isPending}
            style={{ marginTop: 20 }}
          />

          {bioReady ? (
            <Pressable
              onPress={handleBiometricLogin}
              disabled={bioBusy}
              style={({ pressed }) => [
                styles.bioBtn,
                {
                  borderColor: colors.border,
                  borderRadius: colors.radius,
                  opacity: pressed || bioBusy ? 0.7 : 1,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              <Feather
                name={bioLabel === "Face ID" ? "user" : "unlock"}
                size={18}
                color={colors.primary}
              />
              <Text style={[styles.bioBtnText, { color: colors.foreground }]}>
                {t("auth.signInWith", { method: bioLabel })}
              </Text>
            </Pressable>
          ) : null}
            </>
          )}
        </View>

        <Text style={styles.demoLabel}>{t("login.demoAccess")}</Text>
        <View style={[styles.demoRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {DEMO_ACCOUNTS.map((acc) => (
            <Pressable
              key={acc.email}
              onPress={() => {
                setEmail(acc.email);
                setPassword("Admin123!");
                handleLogin(acc.email, "Admin123!");
              }}
              disabled={loginMutation.isPending}
              style={({ pressed }) => [
                styles.demoChip,
                {
                  borderRadius: colors.radius,
                  opacity: pressed ? 0.7 : 1,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              <Feather name="zap" size={14} color="#FFFFFF" />
              <Text style={styles.demoChipText}>{acc.label}</Text>
            </Pressable>
          ))}
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  logoBadge: {
    width: 48,
    height: 48,
    overflow: "hidden",
  },
  logoImg: {
    width: "100%",
    height: "100%",
  },
  brandTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontFamily: FONT.bold,
  },
  brandSub: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  heroBlock: {
    marginTop: 40,
    marginBottom: 28,
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    lineHeight: 40,
    fontFamily: FONT.bold,
  },
  heroText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
    fontFamily: FONT.regular,
  },
  card: {
    padding: 20,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  fieldLabel: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 7,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 50,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.medium,
    height: "100%",
  },
  optionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 14,
  },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  rememberText: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  forgotText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  bioBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 50,
    borderWidth: 1,
    marginTop: 12,
  },
  bioBtnText: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    fontFamily: FONT.medium,
    flex: 1,
  },
  demoLabel: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 28,
    marginBottom: 12,
    textAlign: "center",
  },
  demoRow: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
  },
  demoChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  demoChipText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: FONT.medium,
  },
});
