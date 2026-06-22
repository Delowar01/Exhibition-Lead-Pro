import { Feather } from "@/components/icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
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

import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { FONT, PrimaryButton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();

  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  function handleSubmit() {
    setError(null);
    if (!isValidEmail(email)) {
      setError(t("validation.invalidEmail"));
      return;
    }
    setSubmitted(true);
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
          paddingTop: insets.top + webTopInset + 24,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={20}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
        >
          <Feather name={isRTL ? "arrow-right" : "arrow-left"} size={20} color="#FFFFFF" />
          <Text style={[styles.backText, { textAlign }]}>{t("common.back")}</Text>
        </Pressable>

        <View style={styles.heroBlock}>
          <Text style={[styles.heroTitle, { textAlign }]}>{t("auth.forgotTitle")}</Text>
          <Text style={[styles.heroText, { textAlign }]}>
            {t("auth.forgotBody")}
          </Text>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderRadius: colors.radius + 8 },
          ]}
        >
          {submitted ? (
            <View style={styles.successBlock}>
              <View style={[styles.successIcon, { backgroundColor: colors.success + "1A" }]}>
                <Feather name="check-circle" size={28} color={colors.success} />
              </View>
              <Text style={[styles.successTitle, { color: colors.foreground }]}>
                {t("auth.forgotTitle")}
              </Text>
              <Text style={[styles.successText, { color: colors.mutedForeground }]}>
                {t("auth.forgotBody")}
              </Text>
              <PrimaryButton
                label={t("common.back")}
                icon={isRTL ? "arrow-right" : "arrow-left"}
                onPress={() => router.back()}
                style={{ marginTop: 22, alignSelf: "stretch" }}
              />
            </View>
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
                  autoFocus
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
                label={t("common.confirm")}
                icon="send"
                onPress={handleSubmit}
                style={{ marginTop: 20 }}
              />

              <View style={[styles.hintRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                <Feather name="info" size={13} color={colors.mutedForeground} />
                <Text style={[styles.hintText, { color: colors.mutedForeground, textAlign }]}>
                  {t("auth.contactAdmin")}
                </Text>
              </View>
            </>
          )}
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  backText: {
    color: "#FFFFFF",
    fontSize: 14.5,
    fontFamily: FONT.medium,
  },
  heroBlock: {
    marginTop: 36,
    marginBottom: 28,
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 30,
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
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 16,
    justifyContent: "center",
  },
  hintText: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
  },
  successBlock: {
    alignItems: "center",
  },
  successIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 19,
    fontFamily: FONT.bold,
  },
  successText: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: FONT.regular,
    textAlign: "center",
    marginTop: 8,
  },
});
