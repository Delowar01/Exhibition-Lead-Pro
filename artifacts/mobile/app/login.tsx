import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLogin } from "@workspace/api-client-react";

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { FONT, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

const DEMO_ACCOUNTS = [
  { label: "TechCorp Admin", email: "admin@techcorp.com" },
  { label: "Nexus Admin", email: "admin@nexussys.io" },
];

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const loginMutation = useLogin();

  const [email, setEmail] = useState("admin@techcorp.com");
  const [password, setPassword] = useState("Admin123!");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  async function handleLogin(emailValue: string, passwordValue: string) {
    setError(null);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    try {
      const res = await loginMutation.mutateAsync({
        data: { email: emailValue, password: passwordValue },
      });
      await login(res.token, res.user);
    } catch {
      setError("Invalid email or password. Please try again.");
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
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
        <View style={styles.brandRow}>
          <View style={[styles.logoBadge, { borderRadius: colors.radius + 4 }]}>
            <Image
              source={require("@/assets/images/icon.png")}
              style={styles.logoImg}
              contentFit="cover"
            />
          </View>
          <View>
            <Text style={styles.brandTitle}>Card Scanner Pro</Text>
            <Text style={styles.brandSub}>Field Sales</Text>
          </View>
        </View>

        <View style={styles.heroBlock}>
          <Text style={styles.heroTitle}>Scan. Capture.{"\n"}Close deals.</Text>
          <Text style={styles.heroText}>
            Turn business cards into qualified leads on the floor.
          </Text>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderRadius: colors.radius + 8 },
          ]}
        >
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
            EMAIL
          </Text>
          <View
            style={[
              styles.inputRow,
              { borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <Feather name="mail" size={18} color={colors.mutedForeground} />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              style={[styles.input, { color: colors.foreground }]}
            />
          </View>

          <Text
            style={[
              styles.fieldLabel,
              { color: colors.mutedForeground, marginTop: 16 },
            ]}
          >
            PASSWORD
          </Text>
          <View
            style={[
              styles.inputRow,
              { borderColor: colors.border, borderRadius: colors.radius },
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
            >
              <Feather
                name={showPassword ? "eye-off" : "eye"}
                size={18}
                color={colors.mutedForeground}
              />
            </Pressable>
          </View>

          {error ? (
            <View style={styles.errorRow}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                {error}
              </Text>
            </View>
          ) : null}

          <PrimaryButton
            label="Sign in"
            icon="arrow-right"
            onPress={() => handleLogin(email, password)}
            loading={loginMutation.isPending}
            style={{ marginTop: 20 }}
          />
        </View>

        <Text style={styles.demoLabel}>QUICK DEMO ACCESS</Text>
        <View style={styles.demoRow}>
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
                { borderRadius: colors.radius, opacity: pressed ? 0.7 : 1 },
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
