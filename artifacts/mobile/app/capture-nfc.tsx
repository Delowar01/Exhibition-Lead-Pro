import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { extractedToContact } from "@/lib/contact-parse";
import { NfcError, cancelNfcScan, getNfcSupport, readNfcCard } from "@/lib/nfc";

type Phase = "checking" | "unsupported" | "disabled" | "ready" | "scanning" | "error";

export default function CaptureNfcScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isOnline, enqueueContact } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;

  const [phase, setPhase] = useState<Phase>("checking");
  const [errorMsg, setErrorMsg] = useState("");
  const busyRef = useRef(false);

  const topPad = insets.top;

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
      // Never leave a reader session dangling when the user leaves the screen.
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
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      // NFC data is parsed entirely on-device, so when offline we can queue a
      // ready-to-sync contact directly — no server OCR needed (mirrors QR).
      if (!isOnline) {
        const label =
          [data.firstName, data.lastName].filter(Boolean).join(" ") ||
          data.company ||
          "NFC contact";
        enqueueContact(
          { ...extractedToContact(data), eventId },
          { label, source: "nfc", eventId },
        );
        router.replace("/(tabs)/contacts");
        return;
      }
      // Online: hand off to the shared Lead Preview, which runs the same
      // duplicate detection + save-to-event flow as business-card scanning.
      router.replace({
        pathname: "/scan-review",
        params: { data: JSON.stringify(data), source: "nfc" },
      });
    } catch (err) {
      const code = err instanceof NfcError ? err.code : "unknown";
      if (code === "cancelled") {
        setPhase("ready");
        return;
      }
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      if (code === "disabled") {
        setPhase("disabled");
        return;
      }
      if (code === "unsupported") {
        setPhase("unsupported");
        return;
      }
      setErrorMsg(
        err instanceof NfcError
          ? err.message
          : "Something went wrong while reading the tag.",
      );
      setPhase("error");
    } finally {
      busyRef.current = false;
    }
  }, [eventId, enqueueContact, isOnline, router]);

  const handleCancelScan = useCallback(async () => {
    await cancelNfcScan();
    setPhase("ready");
  }, []);

  function openSettings() {
    if (Platform.OS !== "web") {
      try {
        Linking.openSettings();
      } catch {
        /* noop */
      }
    }
  }

  const accent = "#10B981";

  return (
    <View style={[styles.fill, { backgroundColor: colors.dark, paddingTop: topPad + 60 }]}>
      <Pressable onPress={() => router.back()} style={styles.closeBtn} hitSlop={12}>
        <Feather name="x" size={24} color="#FFFFFF" />
      </Pressable>

      <View style={[styles.iconWrap, { backgroundColor: accent + "22" }]}>
        {phase === "checking" || phase === "scanning" ? (
          <ActivityIndicator size="large" color={accent} />
        ) : (
          <Feather
            name={
              phase === "unsupported"
                ? "slash"
                : phase === "disabled"
                  ? "wifi-off"
                  : phase === "error"
                    ? "alert-triangle"
                    : "wifi"
            }
            size={40}
            color={phase === "error" ? "#F59E0B" : accent}
          />
        )}
      </View>

      {phase === "checking" ? (
        <>
          <Text style={styles.title}>Checking NFC…</Text>
          <Text style={styles.text}>Making sure this device can read NFC tags.</Text>
        </>
      ) : null}

      {phase === "ready" ? (
        <>
          <Text style={styles.title}>Scan an NFC card</Text>
          <Text style={styles.text}>
            Tap the button below, then hold the top of your phone against the
            NFC-enabled business card or tag.
          </Text>
          <View style={styles.actions}>
            <PrimaryButton
              label="Start NFC scan"
              icon="wifi"
              onPress={startScan}
              style={{ alignSelf: "stretch" }}
            />
          </View>
        </>
      ) : null}

      {phase === "scanning" ? (
        <>
          <Text style={styles.title}>Ready — hold near the card</Text>
          <Text style={styles.text}>
            {Platform.OS === "ios"
              ? "Follow the on-screen NFC prompt and hold your phone to the card."
              : "Hold the top of your phone against the NFC card until it reads."}
          </Text>
          <View style={styles.actions}>
            <Pressable onPress={handleCancelScan} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {phase === "unsupported" ? (
        <>
          <Text style={styles.title}>NFC unavailable</Text>
          <Text style={styles.text}>
            This device can't read NFC tags. On iPhone, NFC scanning needs a
            supported model with Core NFC. You can still capture leads with
            Business Card, QR, or Manual Entry.
          </Text>
          <View style={styles.actions}>
            <PrimaryButton
              label="Go back"
              icon="arrow-left"
              onPress={() => router.back()}
              style={{ alignSelf: "stretch" }}
            />
          </View>
        </>
      ) : null}

      {phase === "disabled" ? (
        <>
          <Text style={styles.title}>NFC is turned off</Text>
          <Text style={styles.text}>
            Turn on NFC in your device settings, then come back and try again.
          </Text>
          <View style={styles.actions}>
            <PrimaryButton
              label="Open Settings"
              icon="settings"
              onPress={openSettings}
              style={{ alignSelf: "stretch" }}
            />
            <Pressable
              onPress={async () => {
                const support = await getNfcSupport();
                if (!support.supported) setPhase("unsupported");
                else if (!support.enabled) setPhase("disabled");
                else setPhase("ready");
              }}
              style={styles.ghostBtn}
            >
              <Text style={styles.ghostBtnText}>Try again</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {phase === "error" ? (
        <>
          <Text style={styles.title}>Couldn't read the tag</Text>
          <Text style={styles.text}>{errorMsg}</Text>
          <View style={styles.actions}>
            <PrimaryButton
              label="Try again"
              icon="refresh-cw"
              onPress={startScan}
              style={{ alignSelf: "stretch" }}
            />
            <Pressable onPress={() => router.back()} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>Back to Capture</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", paddingHorizontal: 28 },
  closeBtn: { position: "absolute", top: 56, right: 24, zIndex: 2 },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 40,
    marginBottom: 24,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 24,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  text: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginTop: 12,
  },
  actions: { alignSelf: "stretch", marginTop: 28, gap: 12 },
  ghostBtn: { alignSelf: "center", paddingVertical: 12, paddingHorizontal: 20 },
  ghostBtnText: { color: "rgba(255,255,255,0.85)", fontSize: 15, fontFamily: FONT.semibold },
});
