import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
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
import { useLocale } from "@/hooks/useLocale";
import { COUNTRY_ORDER, getCountry } from "@/lib/countries";
import {
  authenticateBiometric,
  clearBiometricVault,
  getBiometricLabel,
  isBiometricSupported,
  saveBiometricVault,
} from "@/lib/biometric";
import { useAppLock } from "@/contexts/AppLockContext";

const LANGUAGE_OPTIONS: { value: LanguagePref; labelKey: string }[] = [
  { value: "en", labelKey: "settings.english" },
  { value: "ar", labelKey: "settings.arabic" },
];

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, token, logout } = useAuth();
  const settings = useSettings();
  const { unlock } = useAppLock();
  const changePassword = useChangePassword();
  const { t, language, isRTL, textAlign, row } = useLocale();

  const THEME_OPTIONS: { value: ThemePref; label: string; icon: keyof typeof Feather.glyphMap }[] = [
    { value: "light", label: t("settings.themeLight"), icon: "sun" },
    { value: "dark", label: t("settings.themeDark"), icon: "moon" },
    { value: "system", label: t("settings.themeSystem"), icon: "smartphone" },
  ];

  const CAPTURE_OPTIONS: { value: CaptureModePref; label: string; sub: string }[] = [
    { value: "single", label: t("capture.modeSingle"), sub: t("capture.businessCardDesc") },
    { value: "rapid", label: t("capture.modeRapid"), sub: t("capture.subtitle") },
    { value: "batch", label: t("capture.modeBatch"), sub: t("capture.manualDesc") },
  ];

  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [bioSupported, setBioSupported] = useState(false);
  const [bioLabel, setBioLabel] = useState(t("auth.biometrics"));
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
  }

  async function toggleBiometric(value: boolean) {
    haptic();
    if (value) {
      if (!token || !user) {
        Alert.alert(t("errors.notFound"), t("auth.signInFailed"));
        return;
      }
      // Step 1: verify biometrics are available on this device.
      const supported = await isBiometricSupported();
      if (!supported) {
        Alert.alert(
          t("settings.biometricUnavailableTitle"),
          t("settings.biometricUnavailableBody"),
        );
        return;
      }
      // Step 2: require the user to authenticate before enabling the lock.
      setBioBusy(true);
      try {
        const ok = await authenticateBiometric(t("settings.biometricEnablePrompt"));
        if (!ok) {
          // User cancelled or failed — leave the toggle OFF.
          return;
        }
        // Step 3: persist the vault and enable the setting.
        await saveBiometricVault(token, user);
        settings.setBiometricEnabled(true);
      } catch {
        Alert.alert(t("errors.generic"), `${bioLabel}`);
      } finally {
        setBioBusy(false);
      }
    } else {
      setBioBusy(true);
      try {
        await clearBiometricVault();
        settings.setBiometricEnabled(false);
        // Dismiss the lock overlay immediately if it happens to be showing.
        unlock();
      } finally {
        setBioBusy(false);
      }
    }
  }

  async function handleChangePassword() {
    setPwError(null);
    setPwSuccess(false);
    if (!currentPassword || !newPassword) {
      setPwError(t("validation.required"));
      return;
    }
    if (newPassword.length < 8) {
      setPwError(t("validation.tooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError(t("validation.required"));
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
      setPwError(t("errors.saveFailed"));
    }
  }

  function confirmLogout() {
    if (Platform.OS === "web") {
      void logout();
      return;
    }
    Alert.alert(t("settings.logout"), t("auth.logoutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.logout"),
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
          title: t("settings.title"),
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
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile */}
        <View
          style={[
            styles.profileCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, flexDirection: isRTL ? "row-reverse" : "row" },
          ]}
        >
          <Avatar name={user?.name} color={colors.primary} size={52} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.profileName, { color: colors.foreground, textAlign }]}>
              {user?.name ?? "—"}
            </Text>
            <Text numberOfLines={1} style={[styles.profileEmail, { color: colors.mutedForeground, textAlign }]}>
              {user?.email ?? ""}
            </Text>
          </View>
          {user?.role ? <Badge label={prettyLabel(user.role)} color={colors.primary} /> : null}
        </View>

        {/* Language */}
        <Section title={t("settings.language")}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.languageDesc")}
          </Text>
          <View style={[styles.segment, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        {/* Country / Region */}
        <Section title={t("settings.country")}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.countryDesc")}
          </Text>
          {(() => {
            const selected = getCountry(settings.country);
            const selectedName = language === "ar" ? selected.nameAr : selected.nameEn;
            return (
              <Pressable
                onPress={() => {
                  haptic();
                  setCountryPickerOpen(true);
                }}
                style={[
                  styles.countryRow,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.muted,
                    borderRadius: colors.radius + 2,
                    flexDirection: isRTL ? "row-reverse" : "row",
                  },
                ]}
              >
                <Text style={styles.flag}>{selected.flag}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.countryName, { color: colors.foreground, textAlign }]}>
                    {selectedName}
                  </Text>
                  <Text style={[styles.countryDial, { color: colors.mutedForeground, textAlign }]}>
                    {selected.dialCode}
                  </Text>
                </View>
                <Feather
                  name="chevron-down"
                  size={20}
                  color={colors.mutedForeground}
                />
              </Pressable>
            );
          })()}
        </Section>

        {/* Appearance */}
        <Section title={t("settings.appearance")}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.theme")}
          </Text>
          <View style={[styles.segment, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
        </Section>

        {/* Capture */}
        <Section title={t("settings.captureMode")}>
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
                      flexDirection: isRTL ? "row-reverse" : "row",
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.captureLabel, { color: colors.foreground, textAlign }]}>
                      {opt.label}
                    </Text>
                    <Text style={[styles.captureSub, { color: colors.mutedForeground, textAlign }]}>
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
        <Section title={t("settings.notifications")}>
          <View style={[styles.switchRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.foreground, textAlign }]}>
                {t("settings.followUpNotifications")}
              </Text>
              <Text style={[styles.switchSub, { color: colors.mutedForeground, textAlign }]}>
                {t("settings.followUpNotificationsDesc")}
              </Text>
            </View>
            <Switch
              value={settings.followUpNotifications}
              onValueChange={(v) => {
                haptic();
                settings.setFollowUpNotifications(v);
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
            />
          </View>
          <View style={[styles.switchRow, { marginTop: 12, flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchLabel, { color: colors.foreground, textAlign }]}>
                {t("settings.meetingReminders")}
              </Text>
              <Text style={[styles.switchSub, { color: colors.mutedForeground, textAlign }]}>
                {t("settings.meetingRemindersDesc")}
              </Text>
            </View>
            <Switch
              value={settings.meetingReminders}
              onValueChange={(v) => {
                haptic();
                settings.setMeetingReminders(v);
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Section>

        {/* Security */}
        <Section title={t("settings.account")}>
          {Platform.OS !== "web" ? (
            <View style={[styles.switchRow, { marginBottom: 8, flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.switchLabel, { color: colors.foreground, textAlign }]}>
                  {t("settings.biometric")}
                </Text>
                <Text style={[styles.switchSub, { color: colors.mutedForeground, textAlign }]}>
                  {bioSupported
                    ? t("settings.biometricDesc")
                    : t("settings.biometricUnavailableTitle")}
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
              { color: colors.mutedForeground, marginTop: 8, textAlign },
            ]}
          >
            {t("auth.password")}
          </Text>

          {pwError ? (
            <View
              style={[
                styles.banner,
                { backgroundColor: colors.destructive + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" },
              ]}
            >
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.bannerText, { color: colors.destructive, textAlign }]}>{pwError}</Text>
            </View>
          ) : null}
          {pwSuccess ? (
            <View
              style={[
                styles.banner,
                { backgroundColor: colors.success + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" },
              ]}
            >
              <Feather name="check-circle" size={14} color={colors.success} />
              <Text style={[styles.bannerText, { color: colors.success, textAlign }]}>
                {t("success.saved")}
              </Text>
            </View>
          ) : null}

          <PwInput
            placeholder={t("auth.password")}
            value={currentPassword}
            onChangeText={setCurrentPassword}
          />
          <PwInput
            placeholder={t("auth.passwordPlaceholder")}
            value={newPassword}
            onChangeText={setNewPassword}
          />
          <PwInput
            placeholder={t("auth.passwordPlaceholder")}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
          <PrimaryButton
            label={t("common.save")}
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
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>{t("settings.logout")}</Text>
        </Pressable>

        <Text style={[styles.brand, { color: colors.mutedForeground }]}>
          {t("settings.poweredBy")}
        </Text>
      </ScrollView>

      <Modal
        visible={countryPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setCountryPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setCountryPickerOpen(false)}
        >
          <Pressable
            style={[
              styles.modalSheet,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                paddingBottom: insets.bottom + 12,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.modalTitle, { color: colors.foreground, textAlign }]}>
              {t("settings.country")}
            </Text>
            <ScrollView style={{ maxHeight: 420 }}>
              <View style={{ gap: 8 }}>
                {COUNTRY_ORDER.map((code) => {
                  const profile = getCountry(code);
                  const active = settings.country === code;
                  const name = language === "ar" ? profile.nameAr : profile.nameEn;
                  return (
                    <Pressable
                      key={code}
                      onPress={() => {
                        haptic();
                        settings.setCountry(code);
                        setCountryPickerOpen(false);
                      }}
                      style={[
                        styles.countryRow,
                        {
                          borderColor: active ? colors.primary : colors.border,
                          backgroundColor: active ? colors.accent : "transparent",
                          borderRadius: colors.radius + 2,
                          flexDirection: isRTL ? "row-reverse" : "row",
                        },
                      ]}
                    >
                      <Text style={styles.flag}>{profile.flag}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.countryName, { color: colors.foreground, textAlign }]}>
                          {name}
                        </Text>
                        <Text style={[styles.countryDial, { color: colors.mutedForeground, textAlign }]}>
                          {profile.dialCode}
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
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
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
  const { isRTL, writingDirection } = useLocale();
  const [show, setShow] = useState(false);
  return (
    <View
      style={[
        styles.inputWrap,
        { backgroundColor: colors.muted, borderColor: colors.border, borderRadius: colors.radius + 2, flexDirection: isRTL ? "row-reverse" : "row" },
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
        style={[styles.input, { color: colors.foreground, textAlign: isRTL ? "right" : "left", writingDirection }]}
      />
      <Pressable onPress={() => setShow((s) => !s)} hitSlop={8}>
        <Feather name={show ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  const { textAlign } = useLocale();
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
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
    marginHorizontal: 4,
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
  countryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  flag: {
    fontSize: 24,
  },
  countryName: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  countryDial: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: FONT.semibold,
    marginBottom: 14,
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
