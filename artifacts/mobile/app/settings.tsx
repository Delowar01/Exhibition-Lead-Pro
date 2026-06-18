import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useChangePassword } from "@workspace/api-client-react";

import { Avatar, Badge, FONT, PrimaryButton, prettyLabel } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import {
  type CaptureModePref,
  type LanguagePref,
  type ThemePref,
  useSettings,
} from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import {
  clearBiometricVault,
  getBiometricLabel,
  isBiometricSupported,
  saveBiometricVault,
} from "@/lib/biometric";

const THEME_OPTIONS: { value: ThemePref; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "smartphone" },
];

const CAPTURE_OPTIONS: { value: CaptureModePref; label: string; sub: string }[] = [
  { value: "single", label: "Single", sub: "One card at a time" },
  { value: "rapid", label: "Rapid", sub: "Capture back-to-back" },
  { value: "batch", label: "Batch", sub: "Queue, then process" },
];

const LANGUAGE_OPTIONS: { value: LanguagePref; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
];

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, token, logout } = useAuth();
  const settings = useSettings();
  const changePassword = useChangePassword();

  const [bioSupported, setBioSupported] = useState(false);
  const [bioLabel, setBioLabel] = useState("Biometrics");
  const [bioBusy, setBioBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const supported = await isBiometricSupported();
      const label = await getBiometricLabel();
      if (mounted) {
        setBioSupported(supported);
        setBioLabel(label);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  function haptic() {
    if (Platform.OS !== "web") Haptics.selectionAsync();
  }

  async function toggleBiometric(value: boolean) {
    haptic();
    if (value) {
      if (!token || !user) {
        Alert.alert("Not available", "Sign in again to enable biometric sign-in.");
        return;
      }
      setBioBusy(true);
      try {
        await saveBiometricVault(token, user);
        settings.setBiometricEnabled(true);
      } catch {
        Alert.alert("Couldn't enable", `We weren't able to set up ${bioLabel}.`);
      } finally {
        setBioBusy(false);
      }
    } else {
      setBioBusy(true);
      try {
        await clearBiometricVault();
        settings.setBiometricEnabled(false);
      } finally {
        setBioBusy(false);
      }
    }
  }

  async function handleChangePassword() {
    setPwError(null);
    setPwSuccess(false);
    if (!currentPassword || !newPassword) {
      setPwError("Enter your current and new password.");
      return;
    }
    if (newPassword.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("New passwords don't match.");
      return;
    }
    try {
      await changePassword.mutateAsync({ data: { currentPassword, newPassword } });
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setPwError("Couldn't update your password. Check your current password.");
    }
  }

  function confirmLogout() {
    if (Platform.OS === "web") {
      void logout();
      return;
    }
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          void logout();
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: "Settings",
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerLeft:
            Platform.OS === "web"
              ? () => (
                  <Pressable onPress={() => router.back()} hitSlop={10}>
                    <Feather name="arrow-left" size={22} color={colors.foreground} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile */}
        <View
          style={[
            styles.profileCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
          ]}
        >
          <Avatar name={user?.name} color={colors.primary} size={52} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.profileName, { color: colors.foreground }]}>
              {user?.name ?? "—"}
            </Text>
            <Text numberOfLines={1} style={[styles.profileEmail, { color: colors.mutedForeground }]}>
              {user?.email ?? ""}
            </Text>
          </View>
          {user?.role ? <Badge label={prettyLabel(user.role)} color={colors.primary} /> : null}
        </View>

        {/* Appearance */}
        <Section title="Appearance">
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Theme</Text>
          <View style={styles.segment}>
            {THEME_OPTIONS.map((opt) => {
              const active = settings.theme === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    haptic();
                    settings.setTheme(opt.value);
                  }}
                  style={[
                    styles.segmentItem,
                    {
                      backgroundColor: active ? colors.primary : colors.muted,
                      borderRadius: colors.radius,
                    },
                  ]}
                >
                  <Feather
                    name={opt.icon}
                    size={15}
                    color={active ? "#FFFFFF" : colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? "#FFFFFF" : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 18 }]}>
            Language
          </Text>
          <View style={styles.segment}>
            {LANGUAGE_OPTIONS.map((opt) => {
              const active = settings.language === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    haptic();
                    settings.setLanguage(opt.value);
                  }}
                  style={[
                    styles.segmentItem,
                    {
                      backgroundColor: active ? colors.primary : colors.muted,
                      borderRadius: colors.radius,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? "#FFFFFF" : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Capture */}
        <Section title="Default capture mode">
          <View style={{ gap: 10 }}>
            {CAPTURE_OPTIONS.map((opt) => {
              const active = settings.captureMode === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    haptic();
                    settings.setCaptureMode(opt.value);
                  }}
                  style={[
                    styles.captureRow,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.accent : "transparent",
                      borderRadius: colors.radius + 2,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.captureLabel, { color: colors.foreground }]}>
                      {opt.label}
                    </Text>
                    <Text style={[styles.captureSub, { color: colors.mutedForeground }]}>
                      {opt.sub}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.radio,
                      { borderColor: active ? colors.primary : colors.border },
                    ]}
                  >
                    {active ? (
                      <View style={[styles.radioDot, { backgroundColor: colors.primary }]} />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Notifications */}
        <Section title="Notifications">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.foreground }]}>
                Follow-up reminders
              </Text>
              <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>
                Get notified when a lead is due for follow-up.
              </Text>
            </View>
            <Switch
              value={settings.notifications}
              onValueChange={(v) => {
                haptic();
                settings.setNotifications(v);
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Section>

        {/* Security */}
        <Section title="Security">
          {bioSupported ? (
            <View style={[styles.switchRow, { marginBottom: 8 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.foreground }]}>
                  {bioLabel} sign-in
                </Text>
                <Text style={[styles.switchSub, { color: colors.mutedForeground }]}>
                  Unlock the app with {bioLabel} instead of your password.
                </Text>
              </View>
              <Switch
                value={settings.biometricEnabled}
                disabled={bioBusy}
                onValueChange={toggleBiometric}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#FFFFFF"
              />
            </View>
          ) : null}

          <Text
            style={[
              styles.fieldLabel,
              { color: colors.mutedForeground, marginTop: bioSupported ? 8 : 0 },
            ]}
          >
            Change password
          </Text>

          {pwError ? (
            <View
              style={[
                styles.banner,
                { backgroundColor: colors.destructive + "14", borderRadius: colors.radius },
              ]}
            >
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.bannerText, { color: colors.destructive }]}>{pwError}</Text>
            </View>
          ) : null}
          {pwSuccess ? (
            <View
              style={[
                styles.banner,
                { backgroundColor: colors.success + "14", borderRadius: colors.radius },
              ]}
            >
              <Feather name="check-circle" size={14} color={colors.success} />
              <Text style={[styles.bannerText, { color: colors.success }]}>
                Password updated successfully.
              </Text>
            </View>
          ) : null}

          <PwInput
            placeholder="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
          />
          <PwInput
            placeholder="New password (min 8 characters)"
            value={newPassword}
            onChangeText={setNewPassword}
          />
          <PwInput
            placeholder="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
          <PrimaryButton
            label="Update password"
            icon="lock"
            loading={changePassword.isPending}
            onPress={handleChangePassword}
            style={{ marginTop: 6 }}
          />
        </Section>

        {/* Sign out */}
        <Pressable
          onPress={confirmLogout}
          style={({ pressed }) => [
            styles.logoutBtn,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 4,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>Sign out</Text>
        </Pressable>

        <Text style={[styles.brand, { color: colors.mutedForeground }]}>
          Powered by Elite Marcom
        </Text>
      </ScrollView>
    </View>
  );
}

function PwInput({
  placeholder,
  value,
  onChangeText,
}: {
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
}) {
  const colors = useColors();
  const [show, setShow] = useState(false);
  return (
    <View
      style={[
        styles.inputWrap,
        { backgroundColor: colors.muted, borderColor: colors.border, borderRadius: colors.radius + 2 },
      ]}
    >
      <Feather name="lock" size={16} color={colors.mutedForeground} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: colors.foreground }]}
      />
      <Pressable onPress={() => setShow((s) => !s)} hitSlop={8}>
        <Feather name={show ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      <View
        style={[
          styles.sectionBody,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderWidth: 1,
  },
  profileName: {
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  profileEmail: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionBody: {
    borderWidth: 1,
    padding: 16,
  },
  fieldLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginBottom: 8,
  },
  segment: {
    flexDirection: "row",
    gap: 8,
  },
  segmentItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
  },
  segmentText: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    padding: 14,
  },
  captureLabel: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  captureSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  switchLabel: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  switchSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 17,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    marginBottom: 10,
  },
  bannerText: {
    flex: 1,
    fontSize: 12.5,
    fontFamily: FONT.medium,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 50,
    marginBottom: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderWidth: 1,
    marginTop: 26,
  },
  logoutText: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  brand: {
    fontSize: 12,
    fontFamily: FONT.regular,
    textAlign: "center",
    marginTop: 22,
  },
});
