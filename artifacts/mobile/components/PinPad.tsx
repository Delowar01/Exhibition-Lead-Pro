import React, { useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";

import { Feather } from "@/components/icons";
import { FONT } from "@/components/ui";

interface PinPadProps {
  onComplete: (pin: string) => void;
  /**
   * Increment this to reset the pad back to 0 digits.
   * Used by the parent to signal a wrong-PIN attempt.
   */
  resetSignal?: number;
  disabled?: boolean;
  subtitle?: string;
  /** Short error message displayed below the dots (e.g. "Incorrect PIN"). */
  error?: string;
}

const KEY_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "DEL"],
];

/**
 * A dark-themed 4-digit numeric PIN pad (4 dot indicators + 3×4 keypad).
 * The onComplete callback fires when the 4th digit is pressed and the pad
 * immediately clears itself. The parent controls error state via resetSignal.
 */
export function PinPad({
  onComplete,
  resetSignal = 0,
  disabled = false,
  subtitle,
  error,
}: PinPadProps) {
  const [digits, setDigits] = useState<string[]>([]);
  const [flash, setFlash] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Reset + haptic/vibrate whenever the parent signals a wrong attempt.
  const prevResetRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === prevResetRef.current) return;
    prevResetRef.current = resetSignal;
    setDigits([]);
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 500);
    if (Platform.OS !== "web") {
      Vibration.vibrate(250);
    }
    return () => clearTimeout(t);
  }, [resetSignal]);

  // Auto-submit on 4th digit.
  useEffect(() => {
    if (digits.length !== 4) return;
    const pin = digits.join("");
    setDigits([]);
    onCompleteRef.current(pin);
  }, [digits]);

  function pressKey(d: string) {
    if (disabled) return;
    setDigits((prev) => (prev.length < 4 ? [...prev, d] : prev));
  }

  function pressDelete() {
    if (disabled) return;
    setDigits((prev) => prev.slice(0, -1));
  }

  return (
    <View style={styles.container}>
      {subtitle ? (
        <Text style={styles.subtitle}>{subtitle}</Text>
      ) : null}

      {/* 4-dot progress row */}
      <View style={styles.dots}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: flash
                  ? "rgba(239,68,68,0.8)"
                  : i < digits.length
                  ? "#FFFFFF"
                  : "rgba(255,255,255,0.28)",
              },
            ]}
          />
        ))}
      </View>

      {error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : null}

      {/* Keypad */}
      {KEY_ROWS.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {row.map((key, ki) => {
            if (key === "") {
              return <View key={ki} style={styles.keyPlaceholder} />;
            }
            if (key === "DEL") {
              return (
                <Pressable
                  key={ki}
                  onPress={pressDelete}
                  style={({ pressed }) => [
                    styles.key,
                    pressed && styles.keyPressed,
                  ]}
                  accessibilityLabel="Delete"
                >
                  <Feather name="delete" size={22} color="rgba(255,255,255,0.9)" />
                </Pressable>
              );
            }
            return (
              <Pressable
                key={ki}
                onPress={() => pressKey(key)}
                style={({ pressed }) => [
                  styles.key,
                  styles.keyDigit,
                  pressed && styles.keyPressed,
                ]}
                accessibilityLabel={key}
              >
                <Text style={styles.keyText}>{key}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: 8,
  },
  subtitle: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontFamily: FONT.medium,
    textAlign: "center",
    marginBottom: 4,
  },
  dots: {
    flexDirection: "row",
    gap: 18,
    marginBottom: 4,
    marginTop: 8,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  errorText: {
    color: "rgba(239,68,68,0.9)",
    fontSize: 13,
    fontFamily: FONT.medium,
    textAlign: "center",
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    gap: 16,
  },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: KEY_SIZE / 2,
  },
  keyDigit: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  keyPressed: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  keyPlaceholder: {
    width: KEY_SIZE,
    height: KEY_SIZE,
  },
  keyText: {
    color: "#FFFFFF",
    fontSize: 26,
    fontFamily: FONT.medium,
  },
});
