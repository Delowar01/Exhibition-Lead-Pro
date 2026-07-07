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

import { Avatar, Badge, FONT, PrimaryButton, prettyLabel, Card, ListRow } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import {
  type CaptureModePref,
  type LanguagePref,
  type LockTimeoutMs,
  type ThemePref,
  useSettings,
} from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { COUNTRY_ORDER, getCountry } from "@/lib/countries";
import {
  authenticateBiometric,
  clearBiometricVault,
  clearPin,
  getBiometricLabel,
  hasPinSet,
  isBiometricSupported,
  savePin,
  saveBiometricVault,
} from "@/lib/biometric";
import { useAppLock } from "@/contexts/AppLockContext";
import { PinPad } from "@/components/PinPad";

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
  const { unlock, refreshPinAvailability, pinFallbackAvailable } = useAppLock();
  const changePassword = useChangePassword();
  const { t, language, isRTL, textAlign, writingDirection } = useLocale();

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

  // PIN setup modal state
  const [pinSetupVisible, setPinSetupVisible] = useState(false);
  const [pinStep, setPinStep] = useState<1 | 2>(1);
  const [pinFirstPin, setPinFirstPin] = useState("");
  const [pinResetSignal, setPinResetSignal] = useState(0);
  const [pinError, setPinError] = useState<string | null>(null);

  // Change PIN modal state
  const [changePinVisible, setChangePinVisible] = useState(false);
  const [changePinStep, setChangePinStep] = useState<1 | 2>(1);
  const [changePinFirstPin, setChangePinFirstPin] = useState("");
  const [changePinResetSignal, setChangePinResetSignal] = useState(0);
  const [changePinError, setChangePinError] = useState<string | null>(null);

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
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
  }

  async function toggleBiometric(value: boolean) {
    haptic();
    if (value) {
      if (!token || !user) {
        Alert.alert(t("errors.notFound"), t("auth.signInFailed"));
        return;
      }
      const supported = await isBiometricSupported();
      if (!supported) {
        Alert.alert(
          t("settings.biometricUnavailableTitle"),
          t("settings.biometricUnavailableBody"),
        );
        return;
      }
      setBioBusy(true);
      try {
        const ok = await authenticateBiometric(t("settings.biometricEnablePrompt"));
        if (!ok) return;
        await saveBiometricVault(token, user);
        settings.setBiometricEnabled(true);
        setPinStep(1);
        setPinFirstPin("");
        setPinError(null);
        setPinResetSignal(0);
        setPinSetupVisible(true);
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
        unlock();
        const pinExists = await hasPinSet();
        if (pinExists && Platform.OS !== "web") {
          Alert.alert(
            t("settings.removePinTitle"),
            t("settings.removePinBody"),
            [
              { text: t("settings.keepPin"), style: "cancel" },
              {
                text: t("settings.removePin"),
                style: "destructive",
                onPress: () => {
                  void (async () => {
                    await clearPin();
                    await refreshPinAvailability();
                  })();
                },
              },
            ],
          );
        } else {
          await clearPin();
          void refreshPinAvailability();
        }
      } finally {
        setBioBusy(false);
      }
    }
  }

  async function handlePinSetupComplete(pin: string) {
    if (pinStep === 1) {
      setPinFirstPin(pin);
      setPinStep(2);
      setPinError(null);
    } else {
      if (pin !== pinFirstPin) {
        setPinError(t("settings.pinMismatch"));
        setPinResetSignal((s) => s + 1);
        setPinStep(1);
        setPinFirstPin("");
        return;
      }
      await savePin(pin);
      await refreshPinAvailability();
      setPinSetupVisible(false);
    }
  }

  function skipPinSetup() {
    setPinSetupVisible(false);
  }

  function openChangePinModal() {
    setChangePinStep(1);
    setChangePinFirstPin("");
    setChangePinError(null);
    setChangePinResetSignal(0);
    setChangePinVisible(true);
  }

  async function handleChangePinComplete(pin: string) {
    if (changePinStep === 1) {
      setChangePinFirstPin(pin);
      setChangePinStep(2);
      setChangePinError(null);
    } else {
      if (pin !== changePinFirstPin) {
        setChangePinError(t("settings.pinMismatch"));
        setChangePinResetSignal((s) => s + 1);
        setChangePinStep(1);
        setChangePinFirstPin("");
        return;
      }
      await savePin(pin);
      await refreshPinAvailability();
      setChangePinVisible(false);
    }
  }

  async function handleForgotPin() {
    setChangePinVisible(false);
    setBioBusy(true);
    try {
      const ok = await authenticateBiometric(t("settings.biometricEnablePrompt"));
      if (!ok) return;
      await clearPin();
      await refreshPinAvailability();
      openChangePinModal();
    } catch {
      // ignore
    } finally {
      setBioBusy(false);
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
        <Card padded={false} style={{ overflow: "hidden", marginBottom: 24 }}>
          <View style={[styles.profileCard, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Avatar name={user?.name} color={colors.primary} size={64} />
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
        </Card>

        {/* Preferences */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("settings.appearance").toUpperCase()}
        </Text>
        <Card padded={false} style={{ marginBottom: 24, padding: 16 }}>
          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.language")}
          </Text>
          <View style={[styles.segment, { flexDirection: isRTL ? "row-reverse" : "row", marginBottom: 16 }]}>
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
                  <Text style={[styles.segmentText, { color: active ? "#FFFFFF" : colors.foreground }]}>
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.theme")}
          </Text>
          <View style={[styles.segment, { flexDirection: isRTL ? "row-reverse" : "row", marginBottom: 16 }]}>
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
                  <Feather name={opt.icon} size={16} color={active ? "#FFFFFF" : colors.mutedForeground} />
                  <Text style={[styles.segmentText, { color: active ? "#FFFFFF" : colors.foreground }]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("settings.country")}
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
                <Feather name="chevron-down" size={20} color={colors.mutedForeground} />
              </Pressable>
            );
          })()}
        </Card>

        {/* Capture Mode */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("settings.captureMode").toUpperCase()}
        </Text>
        <Card padded={false} style={{ marginBottom: 24 }}>
          {CAPTURE_OPTIONS.map((opt, idx) => {
            const active = settings.captureMode === opt.value;
            return (
              <ListRow
                key={opt.value}
                title={opt.label}
                subtitle={opt.sub}
                onPress={() => {
                  haptic();
                  settings.setCaptureMode(opt.value);
                }}
                showChevron={false}
                style={[
                  styles.menuRow,
                  active && { backgroundColor: colors.accent },
                  idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                ]}
                right={
                  <View style={[styles.radio, { borderColor: active ? colors.primary : colors.border }]}>
                    {active ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
                  </View>
                }
              />
            );
          })}
        </Card>

        {/* Notifications */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("settings.notifications").toUpperCase()}
        </Text>
        <Card padded={false} style={{ marginBottom: 24 }}>
          <ListRow
            title={t("settings.followUpNotifications")}
            subtitle={t("settings.followUpNotificationsDesc")}
            showChevron={false}
            style={styles.menuRow}
            right={
              <Switch
                value={settings.followUpNotifications}
                onValueChange={(v) => {
                  haptic();
                  settings.setFollowUpNotifications(v);
                }}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#FFFFFF"
              />
            }
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
          <ListRow
            title={t("settings.meetingReminders")}
            subtitle={t("settings.meetingRemindersDesc")}
            showChevron={false}
            style={styles.menuRow}
            right={
              <Switch
                value={settings.meetingReminders}
                onValueChange={(v) => {
                  haptic();
                  settings.setMeetingReminders(v);
                }}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#FFFFFF"
              />
            }
          />
        </Card>

        {/* Security */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("settings.account").toUpperCase()}
        </Text>
        <Card padded={false} style={{ padding: 16 }}>
          {Platform.OS !== "web" ? (
            <>
              <View style={[styles.switchRow, { marginBottom: 16, flexDirection: isRTL ? "row-reverse" : "row" }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.switchLabel, { color: colors.foreground, textAlign }]}>
                    {t("settings.biometric")}
                  </Text>
                  <Text style={[styles.switchSub, { color: colors.mutedForeground, textAlign }]}>
                    {bioSupported ? t("settings.biometricDesc") : t("settings.biometricUnavailableTitle")}
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

              {settings.biometricEnabled ? (
                <LockTimeoutPicker value={settings.lockTimeoutMs} onChange={settings.setLockTimeoutMs} />
              ) : null}

              {settings.biometricEnabled && pinFallbackAvailable ? (
                <Pressable
                  onPress={() => {
                    haptic();
                    openChangePinModal();
                  }}
                  style={({ pressed }) => [
                    styles.changePinRow,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.muted,
                      borderRadius: colors.radius + 2,
                      opacity: pressed ? 0.7 : 1,
                      flexDirection: isRTL ? "row-reverse" : "row",
                    },
                  ]}
                >
                  <Feather name="key" size={16} color={colors.primary} />
                  <Text style={[styles.changePinLabel, { color: colors.foreground, textAlign }]}>
                    {t("settings.changePin")}
                  </Text>
                  <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
              
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 20 }} />
            </>
          ) : null}

          <Text style={[styles.fieldLabel, { color: colors.foreground, textAlign, marginBottom: 12 }]}>
            {t("auth.password")}
          </Text>

          {pwError ? (
            <View style={[styles.banner, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.bannerText, { color: colors.destructive, textAlign }]}>{pwError}</Text>
            </View>
          ) : null}
          {pwSuccess ? (
            <View style={[styles.banner, { backgroundColor: colors.success + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <Feather name="check-circle" size={14} color={colors.success} />
              <Text style={[styles.bannerText, { color: colors.success, textAlign }]}>{t("success.saved")}</Text>
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <PwInput placeholder={t("auth.password")} value={currentPassword} onChangeText={setCurrentPassword} isRTL={isRTL} writingDirection={writingDirection} colors={colors} />
            <PwInput placeholder={t("auth.passwordPlaceholder")} value={newPassword} onChangeText={setNewPassword} isRTL={isRTL} writingDirection={writingDirection} colors={colors} />
            <PwInput placeholder={t("auth.passwordPlaceholder")} value={confirmPassword} onChangeText={setConfirmPassword} isRTL={isRTL} writingDirection={writingDirection} colors={colors} />
            <PrimaryButton
              label={t("common.save")}
              icon="lock"
              loading={changePassword.isPending}
              onPress={handleChangePassword}
              style={{ marginTop: 4 }}
            />
          </View>
        </Card>

      </ScrollView>

      {/* Modals for PIN and Country Picker remain essentially identical */}
      <Modal visible={pinSetupVisible} transparent animationType="fade" onRequestClose={skipPinSetup}>
        <View style={pinStyles.backdrop}>
          <View style={[pinStyles.card, { paddingBottom: insets.bottom + 24, backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[pinStyles.title, { color: colors.foreground }]}>{t("settings.pinSetupTitle")}</Text>
            <Text style={[pinStyles.body, { color: colors.mutedForeground }]}>{t("settings.pinSetupBody")}</Text>
            <Text style={[pinStyles.stepLabel, { color: colors.primary }]}>{pinStep === 1 ? t("settings.pinStep1") : t("settings.pinStep2")}</Text>
            <PinPad onComplete={handlePinSetupComplete} resetSignal={pinResetSignal} subtitle={undefined} error={pinError ?? undefined} />
            <Pressable onPress={skipPinSetup} style={({ pressed }) => [pinStyles.skipBtn, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={[pinStyles.skipText, { color: colors.mutedForeground }]}>{t("settings.pinSkip")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={changePinVisible} transparent animationType="fade" onRequestClose={() => setChangePinVisible(false)}>
        <View style={pinStyles.backdrop}>
          <View style={[pinStyles.card, { paddingBottom: insets.bottom + 24, backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[pinStyles.title, { color: colors.foreground }]}>{t("settings.changePinTitle")}</Text>
            <Text style={[pinStyles.stepLabel, { color: colors.primary }]}>{changePinStep === 1 ? t("settings.pinStep1") : t("settings.pinStep2")}</Text>
            <PinPad onComplete={handleChangePinComplete} resetSignal={changePinResetSignal} subtitle={undefined} error={changePinError ?? undefined} />
            <Pressable onPress={handleForgotPin} style={({ pressed }) => [pinStyles.skipBtn, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={[pinStyles.skipText, { color: colors.mutedForeground }]}>{t("settings.forgotPin")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={countryPickerOpen} transparent animationType="slide" onRequestClose={() => setCountryPickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCountryPickerOpen(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: insets.bottom + 12 }]} onPress={(e) => e.stopPropagation()}>
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <Text style={[styles.modalTitle, { color: colors.foreground, textAlign }]}>{t("settings.country")}</Text>
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
                      style={[styles.countryRow, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.accent : "transparent", borderRadius: colors.radius + 2, flexDirection: isRTL ? "row-reverse" : "row" }]}
                    >
                      <Text style={styles.flag}>{profile.flag}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.countryName, { color: colors.foreground, textAlign }]}>{name}</Text>
                        <Text style={[styles.countryDial, { color: colors.mutedForeground, textAlign }]}>{profile.dialCode}</Text>
                      </View>
                      <View style={[styles.radio, { borderColor: active ? colors.primary : colors.border }]}>
                        {active ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
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

const LOCK_TIMEOUT_OPTIONS: { value: LockTimeoutMs; labelKey: string }[] = [
  { value: 0, labelKey: "settings.lockTimeoutImmediately" },
  { value: 15_000, labelKey: "settings.lockTimeout15s" },
  { value: 30_000, labelKey: "settings.lockTimeout30s" },
  { value: 60_000, labelKey: "settings.lockTimeout1min" },
  { value: 300_000, labelKey: "settings.lockTimeout5min" },
];

function LockTimeoutPicker({ value, onChange }: { value: LockTimeoutMs; onChange: (v: LockTimeoutMs) => void; }) {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign, marginBottom: 8 }]}>
        {t("settings.lockTimeoutLabel")}
      </Text>
      <View style={[styles.segment, { flexWrap: "wrap", flexDirection: isRTL ? "row-reverse" : "row" }]}>
        {LOCK_TIMEOUT_OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[
                styles.segmentItem,
                {
                  backgroundColor: active ? colors.primary : colors.muted,
                  borderRadius: colors.radius,
                  minWidth: 72,
                  flex: undefined,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                },
              ]}
            >
              <Text style={[styles.segmentText, { color: active ? "#FFFFFF" : colors.foreground, fontSize: 13 }]}>
                {t(opt.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PwInput({ placeholder, value, onChangeText, isRTL, writingDirection, colors }: any) {
  const [show, setShow] = useState(false);
  return (
    <View style={[styles.inputWrap, { backgroundColor: colors.muted, borderColor: colors.border, borderRadius: colors.radius + 2, flexDirection: isRTL ? "row-reverse" : "row" }]}>
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

const styles = StyleSheet.create({
  profileCard: {
    alignItems: "center",
    gap: 16,
    padding: 16,
  },
  profileName: {
    fontSize: 20,
    fontFamily: FONT.bold,
  },
  profileEmail: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: FONT.semibold,
    letterSpacing: 0.8,
    marginBottom: 10,
    marginLeft: 4,
  },
  fieldLabel: {
    fontSize: 13,
    fontFamily: FONT.semibold,
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
    paddingVertical: 12,
  },
  segmentText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  countryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  flag: {
    fontSize: 24,
  },
  countryName: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  countryDial: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
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
    fontSize: 18,
    fontFamily: FONT.bold,
    marginBottom: 14,
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
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  menuRow: {
    paddingHorizontal: 16,
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
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 18,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    marginBottom: 12,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 52,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
  changePinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    marginTop: 10,
  },
  changePinLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.medium,
  },
});

const pinStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
  },
  title: {
    fontSize: 22,
    fontFamily: FONT.bold,
    marginBottom: 8,
    textAlign: "center",
  },
  body: {
    fontSize: 15,
    fontFamily: FONT.regular,
    textAlign: "center",
    marginBottom: 20,
    paddingHorizontal: 10,
    lineHeight: 22,
  },
  stepLabel: {
    fontSize: 14,
    fontFamily: FONT.semibold,
    marginBottom: 16,
  },
  skipBtn: {
    marginTop: 24,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  skipText: {
    fontSize: 15,
    fontFamily: FONT.medium,
  },
});
