/**
 * Premium NFC Capture Screen
 *
 * Visual design: Apple Wallet / Samsung Pay style — dark gradient background,
 * floating card illustration, animated NFC waves, glassmorphism instruction
 * card, smooth phase transitions powered by React Native Reanimated 4.
 *
 * NFC logic is unchanged from lib/nfc.ts.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

import { Feather } from "@/components/icons";
import { FONT } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useLocale } from "@/hooks/useLocale";
import { extractedToContact } from "@/lib/contact-parse";
import {
  NfcError,
  cancelNfcScan,
  getNfcSupport,
  readNfcCard,
} from "@/lib/nfc";

// ─── Design tokens ────────────────────────────────────────────────────────────
const BRAND = "#FF6B00";
const BRAND_DIM = "#FF6B0040";
const SUCCESS = "#34D399";
const SUCCESS_DIM = "#34D39930";
const WAVE_COLOR = "#FF6B00";
const BG_TOP = "#0B0D14";
const BG_MID = "#0E1020";
const BG_BOT = "#120E1C";

// ─── Phase type ───────────────────────────────────────────────────────────────
type Phase =
  | "checking"
  | "unsupported"
  | "disabled"
  | "ready"
  | "scanning"
  | "success"
  | "error";

// ─── WaveRing ─────────────────────────────────────────────────────────────────
const WaveRing = memo(function WaveRing({
  delayMs,
  fast,
  color,
  size,
}: {
  delayMs: number;
  fast: boolean;
  color: string;
  size: number;
}) {
  const progress = useSharedValue(0);
  const duration = fast ? 800 : 1600;

  useEffect(() => {
    progress.value = 0;
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withTiming(1, { duration, easing: Easing.out(Easing.cubic) }),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(progress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fast]);

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.15, 0.7, 1], [0, 0.8, 0.4, 0]),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.25, 1.6]) },
    ],
  }));

  return (
    <Animated.View
      style={[
        styles.waveRing,
        { width: size, height: size, borderRadius: size / 2, borderColor: color },
        style,
      ]}
    />
  );
});

// ─── NFC Waves Hub ────────────────────────────────────────────────────────────
const NfcWavesHub = memo(function NfcWavesHub({
  phase,
}: {
  phase: Phase;
}) {
  const scanning = phase === "scanning";
  const success = phase === "success";
  const color = success ? SUCCESS : WAVE_COLOR;

  // Center icon pulse
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (scanning) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 500, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    } else {
      cancelAnimation(pulse);
      pulse.value = withSpring(1);
    }
    return () => cancelAnimation(pulse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  // Success scale-in
  const successScale = useSharedValue(0);
  useEffect(() => {
    if (success) {
      successScale.value = withSpring(1, { damping: 12, stiffness: 180 });
    } else {
      successScale.value = 0;
    }
  }, [success, successScale]);

  const centerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  const successStyle = useAnimatedStyle(() => ({
    transform: [{ scale: successScale.value }],
    opacity: successScale.value,
  }));

  const iconColor =
    phase === "ready" || phase === "scanning" ? BRAND : phase === "success" ? SUCCESS : "#64748B";
  const bgColor =
    phase === "success" ? SUCCESS_DIM : phase === "scanning" ? BRAND_DIM : "#1A1F2E";

  return (
    <View style={styles.wavesHub}>
      {/* Expanding rings */}
      {(phase === "scanning" || phase === "ready") && (
        <>
          <WaveRing delayMs={0}    fast={scanning} color={color} size={160} />
          <WaveRing delayMs={scanning ? 200 : 400} fast={scanning} color={color} size={160} />
          <WaveRing delayMs={scanning ? 400 : 800} fast={scanning} color={color} size={160} />
          <WaveRing delayMs={scanning ? 600 : 1200} fast={scanning} color={color} size={160} />
        </>
      )}

      {/* Center icon */}
      <Animated.View style={[styles.hubCenter, { backgroundColor: bgColor }, centerStyle]}>
        {success ? (
          <Animated.View style={successStyle}>
            <Feather name="check" size={36} color={SUCCESS} />
          </Animated.View>
        ) : (
          <NfcSymbol size={40} color={iconColor} />
        )}
      </Animated.View>
    </View>
  );
});

// ─── NFC Symbol SVG ───────────────────────────────────────────────────────────
function NfcSymbol({ size, color }: { size: number; color: string }) {
  const s = size;
  // Three concentric arcs typical of NFC / Wi-Fi style icon
  return (
    <Svg width={s} height={s} viewBox="0 0 40 40">
      {/* Center dot */}
      <Circle cx={20} cy={20} r={3.5} fill={color} />
      {/* Inner arc */}
      <Path
        d="M12.5 27.5 A10.6 10.6 0 0 1 12.5 12.5"
        stroke={color} strokeWidth={2.4} fill="none"
        strokeLinecap="round"
      />
      {/* Middle arc */}
      <Path
        d="M8 32 A16.97 16.97 0 0 1 8 8"
        stroke={color} strokeWidth={2} fill="none"
        strokeLinecap="round" opacity={0.7}
      />
      {/* Outer arc */}
      <Path
        d="M3.5 36.5 A23.33 23.33 0 0 1 3.5 3.5"
        stroke={color} strokeWidth={1.6} fill="none"
        strokeLinecap="round" opacity={0.4}
      />
    </Svg>
  );
}

// ─── Floating Card illustration ───────────────────────────────────────────────
const FloatingCard = memo(function FloatingCard({
  scanning,
}: {
  scanning: boolean;
}) {
  const float = useSharedValue(0);
  const tilt = useSharedValue(0);

  useEffect(() => {
    float.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 2200, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
    tilt.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 3400, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 3400, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    );
    return () => {
      cancelAnimation(float);
      cancelAnimation(tilt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(float.value, [0, 1], [0, -10]) },
      { rotate: `${interpolate(tilt.value, [0, 1], [-4, 4])}deg` },
      { scale: scanning ? 1.04 : 1 },
    ],
    shadowOpacity: interpolate(float.value, [0, 1], [0.18, 0.38]),
  }));

  return (
    <Animated.View style={[styles.cardIllustration, style]}>
      <Svg width={178} height={106} viewBox="0 0 178 106">
        <Defs>
          <SvgLinearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor="#1C2840" />
            <Stop offset="100%" stopColor="#0D1425" />
          </SvgLinearGradient>
          <SvgLinearGradient id="og" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor="#FF6B00" stopOpacity="0.9" />
            <Stop offset="100%" stopColor="#E85500" stopOpacity="0.7" />
          </SvgLinearGradient>
        </Defs>
        {/* Card body */}
        <Rect x={1} y={1} width={176} height={104} rx={11} fill="url(#cg)" />
        {/* Sheen top edge */}
        <Rect x={1} y={1} width={176} height={18} rx={11} fill="rgba(255,255,255,0.05)" />
        {/* Card border */}
        <Rect x={0.5} y={0.5} width={177} height={105} rx={11.5} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />

        {/* Brand stripe left */}
        <Rect x={1} y={1} width={6} height={104} rx={3} fill="url(#og)" />

        {/* NFC symbol top-right */}
        <Circle cx={152} cy={24} r={4.5} fill="none" stroke={BRAND} strokeWidth={1.8} />
        <Circle cx={152} cy={24} r={9} fill="none" stroke={BRAND} strokeWidth={1.2} opacity={0.6} />
        <Circle cx={152} cy={24} r={13} fill="none" stroke={BRAND} strokeWidth={0.8} opacity={0.3} />

        {/* "Name" placeholder */}
        <Rect x={22} y={22} width={90} height={9} rx={4.5} fill="rgba(255,255,255,0.75)" />
        {/* "Title" placeholder */}
        <Rect x={22} y={37} width={68} height={6} rx={3} fill="rgba(255,255,255,0.35)" />

        {/* Company chip */}
        <Rect x={22} y={56} width={34} height={22} rx={4} fill="rgba(255,107,0,0.2)" stroke={BRAND} strokeWidth={0.8} strokeOpacity={0.5} />
        <Rect x={27} y={63} width={24} height={3.5} rx={1.75} fill={BRAND} opacity={0.7} />
        <Rect x={29} y={69} width={20} height={3} rx={1.5} fill={BRAND} opacity={0.4} />

        {/* Bottom contact lines */}
        <Rect x={22} y={82} width={58} height={4} rx={2} fill="rgba(255,255,255,0.22)" />
        <Rect x={22} y={91} width={76} height={4} rx={2} fill="rgba(255,255,255,0.14)" />
      </Svg>
    </Animated.View>
  );
});

// ─── Signal beam (card → phone) ───────────────────────────────────────────────
const SignalBeam = memo(function SignalBeam({ visible }: { visible: boolean }) {
  const opacity = useSharedValue(0);
  const particleA = useSharedValue(0);
  const particleB = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 400 });
      particleA.value = 0;
      particleB.value = 0;
      particleA.value = withRepeat(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        -1,
        false,
      );
      particleB.value = withDelay(
        450,
        withRepeat(
          withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
          -1,
          false,
        ),
      );
    } else {
      opacity.value = withTiming(0, { duration: 300 });
      cancelAnimation(particleA);
      cancelAnimation(particleB);
    }
    return () => {
      cancelAnimation(opacity);
      cancelAnimation(particleA);
      cancelAnimation(particleB);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const wrapStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const pa = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(particleA.value, [0, 1], [0, 56]) }],
    opacity: interpolate(particleA.value, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
  }));
  const pb = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(particleB.value, [0, 1], [0, 56]) }],
    opacity: interpolate(particleB.value, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
  }));

  return (
    <Animated.View style={[styles.beamWrap, wrapStyle]} pointerEvents="none">
      <View style={styles.beamLine} />
      <Animated.View style={[styles.beamParticle, pa]} />
      <Animated.View style={[styles.beamParticle, pb]} />
    </Animated.View>
  );
});

// ─── Phone body illustration ──────────────────────────────────────────────────
const PhoneBody = memo(function PhoneBody({
  scanning,
}: {
  scanning: boolean;
}) {
  const breath = useSharedValue(1);

  useEffect(() => {
    if (scanning) {
      breath.value = withRepeat(
        withSequence(
          withTiming(1.025, { duration: 900, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    } else {
      breath.value = withRepeat(
        withSequence(
          withTiming(1.012, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    }
    return () => cancelAnimation(breath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: breath.value }],
  }));

  return (
    <Animated.View style={style}>
      <Svg width={72} height={126} viewBox="0 0 72 126">
        <Defs>
          <SvgLinearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#1E2840" />
            <Stop offset="100%" stopColor="#0D1220" />
          </SvgLinearGradient>
        </Defs>
        {/* Phone body */}
        <Rect x={1} y={1} width={70} height={124} rx={14} fill="url(#pg)" />
        <Rect x={0.5} y={0.5} width={71} height={125} rx={14.5} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={1} />
        {/* Screen area */}
        <Rect x={5} y={10} width={62} height={106} rx={10} fill="#080B14" />
        {/* Dynamic island */}
        <Rect x={24} y={12.5} width={24} height={8} rx={4} fill="#1A2035" />
        {/* Faint app content */}
        <Rect x={12} y={32} width={48} height={5} rx={2.5} fill="rgba(255,107,0,0.3)" />
        <Rect x={12} y={41} width={36} height={3.5} rx={1.75} fill="rgba(255,255,255,0.08)" />
        <Rect x={12} y={49} width={44} height={3.5} rx={1.75} fill="rgba(255,255,255,0.06)" />
        {/* NFC indicator dot on back (shown on front as subtle hint) */}
        <Circle cx={36} cy={91} r={4} fill="rgba(255,107,0,0.18)" stroke={BRAND} strokeWidth={0.8} strokeOpacity={0.5} />
        {/* Volume buttons */}
        <Rect x={-1} y={34} width={2.5} height={14} rx={1.25} fill="#2A3550" />
        <Rect x={-1} y={52} width={2.5} height={12} rx={1.25} fill="#2A3550" />
        {/* Power button */}
        <Rect x={70.5} y={42} width={2.5} height={18} rx={1.25} fill="#2A3550" />
      </Svg>
    </Animated.View>
  );
});

// ─── Instruction card ─────────────────────────────────────────────────────────
const TIPS = [
  { icon: "maximize" as const, textKey: "nfc.tipSteady" },
  { icon: "clock"   as const, textKey: "nfc.tipHold" },
  { icon: "check"   as const, textKey: "nfc.tipRemove" },
];

const InstructionCard = memo(function InstructionCard() {
  const { t } = useLocale();
  return (
    <View style={styles.instructionCard}>
      <Text style={styles.instructionTitle}>
        {t("nfc.instructionTitle")}
      </Text>
      <View style={styles.tipsRow}>
        {TIPS.map(({ icon, textKey }) => (
          <View key={icon} style={styles.tip}>
            <View style={styles.tipIcon}>
              <Feather name={icon} size={14} color={BRAND} />
            </View>
            <Text style={styles.tipText}>{t(textKey)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
});

// ─── Main screen ──────────────────────────────────────────────────────────────
export default function CaptureNfcScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useLocale();
  const { isOnline, enqueueContact } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;

  const [phase, setPhase] = useState<Phase>("checking");
  const [errorMsg, setErrorMsg] = useState("");
  const busyRef = useRef(false);

  // Screen fade-in
  const screenOpacity = useSharedValue(0);
  const screenStyle = useAnimatedStyle(() => ({ opacity: screenOpacity.value }));
  useEffect(() => {
    screenOpacity.value = withTiming(1, { duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NFC support check on mount
  useEffect(() => {
    let active = true;
    (async () => {
      const support = await getNfcSupport();
      if (!active) return;
      if (!support.supported) setPhase("unsupported");
      else if (!support.enabled) setPhase("disabled");
      else setPhase("ready");
    })();
    return () => {
      active = false;
      cancelNfcScan();
    };
  }, []);

  const startScan = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("scanning");
    setErrorMsg("");
    try {
      const data = await readNfcCard();

      // Success: haptic + brief success phase, then navigate
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setPhase("success");

      await new Promise((r) => setTimeout(r, 1100));

      if (!isOnline) {
        const label =
          [data.firstName, data.lastName].filter(Boolean).join(" ") ||
          data.company ||
          t("nfc.contactFallback");
        enqueueContact(
          { ...extractedToContact(data), eventId },
          { label, source: "nfc", eventId },
        );
        router.replace("/(tabs)/contacts");
        return;
      }
      router.replace({
        pathname: "/scan-review",
        params: { data: JSON.stringify(data), source: "nfc" },
      });
    } catch (err) {
      const code = err instanceof NfcError ? err.code : "unknown";
      if (code === "cancelled") { setPhase("ready"); return; }
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      if (code === "disabled") { setPhase("disabled"); return; }
      if (code === "unsupported") { setPhase("unsupported"); return; }
      setErrorMsg(
        err instanceof NfcError
          ? err.message
          : t("nfc.errorGeneric"),
      );
      setPhase("error");
    } finally {
      busyRef.current = false;
    }
  }, [eventId, enqueueContact, isOnline, router]);

  const handleCancel = useCallback(async () => {
    await cancelNfcScan();
    setPhase("ready");
  }, []);

  const handleRetry = useCallback(async () => {
    const support = await getNfcSupport();
    if (!support.supported) { setPhase("unsupported"); return; }
    if (!support.enabled) { setPhase("disabled"); return; }
    setPhase("ready");
  }, []);

  const isScanning = phase === "scanning";
  const isSuccess = phase === "success";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Animated.View style={[styles.root, screenStyle]}>
      <LinearGradient
        colors={[BG_TOP, BG_MID, BG_BOT]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* Close button */}
      <Pressable
        onPress={() => router.back()}
        style={[styles.closeBtn, { top: insets.top + 12 }]}
        hitSlop={16}
      >
        <View style={styles.closeBtnInner}>
          <Feather name="x" size={20} color="rgba(255,255,255,0.85)" />
        </View>
      </Pressable>

      {/* ── Illustration area ── */}
      <View style={styles.illustrationArea}>
        <FloatingCard scanning={isScanning} />
        <SignalBeam visible={isScanning} />
        <PhoneBody scanning={isScanning} />
      </View>

      {/* ── NFC waves ── */}
      <NfcWavesHub phase={phase} />

      {/* ── Status text ── */}
      <StatusBlock phase={phase} errorMsg={errorMsg} />

      {/* ── Instruction card ── */}
      {(phase === "ready" || phase === "scanning" || phase === "checking") && (
        <InstructionCard />
      )}

      {/* ── Action area ── */}
      <View style={[styles.actions, { paddingBottom: insets.bottom + 28 }]}>
        {phase === "ready" && (
          <PremiumButton
            label={t("nfc.start")}
            icon="wifi"
            onPress={startScan}
            color={BRAND}
          />
        )}
        {phase === "scanning" && (
          <Pressable onPress={handleCancel} style={styles.ghostBtn}>
            <Text style={styles.ghostBtnText}>{t("common.cancel")}</Text>
          </Pressable>
        )}
        {phase === "success" && (
          <View style={styles.successLabel}>
            <Feather name="check-circle" size={18} color={SUCCESS} />
            <Text style={[styles.ghostBtnText, { color: SUCCESS, marginLeft: 6 }]}>
              {t("nfc.detectedSuccess")}
            </Text>
          </View>
        )}
        {phase === "error" && (
          <>
            <PremiumButton
              label={t("nfc.tryAgain")}
              icon="refresh-cw"
              onPress={startScan}
              color={BRAND}
            />
            <Pressable onPress={() => router.back()} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>{t("nfc.backToCapture")}</Text>
            </Pressable>
          </>
        )}
        {phase === "disabled" && (
          <>
            <PremiumButton
              label={t("nfc.openSettings")}
              icon="settings"
              onPress={() => { if (Platform.OS !== "web") Linking.openSettings(); }}
              color={BRAND}
            />
            <Pressable onPress={handleRetry} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>{t("nfc.tryAgain")}</Text>
            </Pressable>
          </>
        )}
        {phase === "unsupported" && (
          <PremiumButton
            label={t("nfc.goBack")}
            icon="arrow-left"
            onPress={() => router.back()}
            color="#4B5563"
          />
        )}
      </View>
    </Animated.View>
  );
}

// ─── Status block ─────────────────────────────────────────────────────────────
function buildStatus(t: ReturnType<typeof useLocale>["t"]): Record<Phase, { title: string; sub: string }> {
  return {
    checking:    { title: t("nfc.checkingTitle"),      sub: t("nfc.checkingSub") },
    ready:       { title: t("nfc.readyTitle"),         sub: t("nfc.readySub") },
    scanning:    { title: t("nfc.searchingTitle"),   sub: Platform.OS === "ios" ? t("nfc.searchingSubPrompt") : t("nfc.searchingSubHold") },
    success:     { title: t("nfc.successTitle"),       sub: t("nfc.successSub") },
    error:       { title: t("nfc.errorTitle"),         sub: "" },
    disabled:    { title: t("nfc.disabledTitle"),      sub: t("nfc.disabledSub") },
    unsupported: { title: t("nfc.unsupportedTitle"),   sub: t("nfc.unsupportedSub") },
  };
}

function StatusBlock({ phase, errorMsg }: { phase: Phase; errorMsg: string }) {
  const { t } = useLocale();
  const titleColor =
    phase === "success" ? SUCCESS
    : phase === "error"  ? "#F87171"
    : "#F8F9FB";
  const { title, sub } = buildStatus(t)[phase];
  return (
    <View style={styles.statusBlock}>
      <Text style={[styles.statusTitle, { color: titleColor }]}>{title}</Text>
      <Text style={styles.statusSub} numberOfLines={2}>
        {phase === "error" && errorMsg ? errorMsg : sub}
      </Text>
    </View>
  );
}

// ─── Premium button ───────────────────────────────────────────────────────────
function PremiumButton({
  label,
  icon,
  onPress,
  color,
}: {
  label: string;
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  color: string;
}) {
  const scale = useSharedValue(1);
  const btnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => { scale.value = withSpring(0.96, { damping: 15, stiffness: 300 }); }}
      onPressOut={() => { scale.value = withSpring(1, { damping: 15, stiffness: 300 }); }}
    >
      <Animated.View style={btnStyle}>
        <LinearGradient
          colors={[color, adjustBrightness(color, -20)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.premiumBtn}
        >
          <Feather name={icon} size={18} color="#FFFFFF" />
          <Text style={styles.premiumBtnText}>{label}</Text>
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

/** Darken a hex color by `amount` (0–255). */
function adjustBrightness(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
  },
  closeBtn: {
    position: "absolute",
    right: 20,
    zIndex: 10,
  },
  closeBtnInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Illustration
  illustrationArea: {
    marginTop: 72,
    alignItems: "center",
    justifyContent: "center",
    height: 240,
    width: "100%",
  },
  cardIllustration: {
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 20,
    shadowOpacity: 0.25,
    elevation: 12,
    position: "absolute",
    top: 0,
  },
  beamWrap: {
    position: "absolute",
    top: 118,
    alignItems: "center",
    height: 66,
    width: 4,
    overflow: "visible",
  },
  beamLine: {
    position: "absolute",
    top: 0,
    width: 1,
    height: 56,
    backgroundColor: "rgba(255,107,0,0.18)",
  },
  beamParticle: {
    position: "absolute",
    top: 0,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },

  // Waves hub
  wavesHub: {
    width: 160,
    height: 160,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -10,
  },
  waveRing: {
    position: "absolute",
    borderWidth: 1.5,
  },
  hubCenter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 18,
    shadowOpacity: 0.5,
    elevation: 8,
  },

  // Status
  statusBlock: {
    alignItems: "center",
    paddingHorizontal: 32,
    marginTop: 12,
    gap: 5,
  },
  statusTitle: {
    fontFamily: FONT.bold,
    fontSize: 22,
    color: "#F8F9FB",
    textAlign: "center",
  },
  statusSub: {
    fontFamily: FONT.regular,
    fontSize: 14,
    color: "rgba(255,255,255,0.52)",
    textAlign: "center",
    lineHeight: 20,
  },

  // Instruction card (glassmorphism style via layered semi-transparent views)
  instructionCard: {
    marginHorizontal: 20,
    marginTop: 16,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  instructionTitle: {
    fontFamily: FONT.semibold,
    fontSize: 13,
    color: "rgba(255,255,255,0.75)",
    textAlign: "center",
    lineHeight: 18,
  },
  tipsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  tip: {
    alignItems: "center",
    gap: 5,
    flex: 1,
  },
  tipIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(255,107,0,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  tipText: {
    fontFamily: FONT.regular,
    fontSize: 11,
    color: "rgba(255,255,255,0.45)",
    textAlign: "center",
    lineHeight: 15,
  },

  // Actions
  actions: {
    alignSelf: "stretch",
    paddingHorizontal: 24,
    marginTop: "auto",
    gap: 10,
  },
  premiumBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 14,
  },
  premiumBtnText: {
    fontFamily: FONT.semibold,
    fontSize: 16,
    color: "#FFFFFF",
    letterSpacing: 0.2,
  },
  ghostBtn: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  ghostBtnText: {
    fontFamily: FONT.semibold,
    fontSize: 15,
    color: "rgba(255,255,255,0.65)",
  },
  successLabel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
  },
});
