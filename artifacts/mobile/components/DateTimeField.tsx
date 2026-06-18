import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Parse a plain "YYYY-MM-DD" into a local Date (avoids UTC-midnight shift).
function parseLocalDate(s?: string | null): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map((p) => parseInt(p, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDisplay(dateStr?: string | null, timeStr?: string | null): string {
  const d = parseLocalDate(dateStr);
  if (!d) return "";
  const datePart = formatGregorian(d, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!timeStr) return datePart;
  const [h, m] = timeStr.split(":").map((p) => parseInt(p, 10));
  const period = h >= 12 ? "PM" : "AM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${datePart} · ${hr12}:${pad2(m)} ${period}`;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

export interface DateTimeFieldProps {
  label: string;
  date: string | null;
  time?: string | null;
  onChange: (date: string | null, time: string | null) => void;
  withTime?: boolean;
  optional?: boolean;
  minToday?: boolean;
}

export function DateTimeField({
  label,
  date,
  time,
  onChange,
  withTime = true,
  optional = false,
  minToday = false,
}: DateTimeFieldProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const selected = parseLocalDate(date);
  const [cursor, setCursor] = useState<Date>(() => {
    const base = parseLocalDate(date) ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  // Parse current time into 12h parts.
  const [th, tm] = (time ?? "").split(":");
  const hour24 = parseInt(th ?? "", 10);
  const minute = parseInt(tm ?? "", 10);
  const hasTime = !Number.isNaN(hour24);
  const period: "AM" | "PM" = hasTime && hour24 >= 12 ? "PM" : "AM";
  const hour12 = hasTime ? (hour24 % 12 === 0 ? 12 : hour24 % 12) : 9;
  const curMinute = hasTime ? minute : 0;

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < startPad; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const todayStr = dateToStr(new Date());

  function haptic() {
    if (Platform.OS !== "web") Haptics.selectionAsync();
  }

  function commitTime(h12: number, min: number, per: "AM" | "PM") {
    let h24 = h12 % 12;
    if (per === "PM") h24 += 12;
    onChange(date, `${pad2(h24)}:${pad2(min)}`);
  }

  function pickDay(d: Date) {
    haptic();
    const ds = dateToStr(d);
    // If time is required but not set yet, default to 09:00.
    const nextTime = withTime ? (time ?? "09:00") : null;
    onChange(ds, nextTime);
  }

  const display = formatDisplay(date, withTime ? time : null);

  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>
        {label.toUpperCase()}
      </Text>
      <Pressable
        onPress={() => {
          haptic();
          setOpen(true);
        }}
        style={({ pressed }) => [
          styles.field,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Feather name="calendar" size={18} color={colors.primary} />
        <Text
          style={[
            styles.fieldText,
            { color: display ? colors.foreground : colors.mutedForeground },
          ]}
        >
          {display || (optional ? "Optional — tap to set" : "Tap to choose")}
        </Text>
        {date && optional ? (
          <Pressable
            hitSlop={10}
            onPress={(e) => {
              e.stopPropagation();
              onChange(null, null);
            }}
          >
            <Feather name="x" size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                paddingBottom: insets.bottom + 16,
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.handleWrap}>
              <View style={[styles.handle, { backgroundColor: colors.border }]} />
            </View>

            {/* Month navigation */}
            <View style={styles.monthRow}>
              <Pressable
                hitSlop={10}
                onPress={() => {
                  haptic();
                  setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1));
                }}
                style={[styles.navBtn, { backgroundColor: colors.muted }]}
              >
                <Feather name="chevron-left" size={20} color={colors.foreground} />
              </Pressable>
              <Text style={[styles.monthLabel, { color: colors.foreground }]}>
                {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
              </Text>
              <Pressable
                hitSlop={10}
                onPress={() => {
                  haptic();
                  setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1));
                }}
                style={[styles.navBtn, { backgroundColor: colors.muted }]}
              >
                <Feather name="chevron-right" size={20} color={colors.foreground} />
              </Pressable>
            </View>

            {/* Weekday header */}
            <View style={styles.weekRow}>
              {WEEKDAYS.map((w, i) => (
                <Text
                  key={i}
                  style={[styles.weekday, { color: colors.mutedForeground }]}
                >
                  {w}
                </Text>
              ))}
            </View>

            {/* Day grid */}
            <View style={styles.grid}>
              {cells.map((cell, i) => {
                if (!cell) return <View key={i} style={styles.cell} />;
                const ds = dateToStr(cell);
                const isSelected = selected && dateToStr(selected) === ds;
                const isToday = ds === todayStr;
                const disabled = minToday && ds < todayStr;
                return (
                  <Pressable
                    key={i}
                    disabled={disabled}
                    onPress={() => pickDay(cell)}
                    style={styles.cell}
                  >
                    <View
                      style={[
                        styles.dayInner,
                        isSelected && { backgroundColor: colors.primary },
                        !isSelected && isToday && {
                          borderWidth: 1,
                          borderColor: colors.primary,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          {
                            color: disabled
                              ? colors.mutedForeground + "66"
                              : isSelected
                                ? "#FFFFFF"
                                : colors.foreground,
                          },
                        ]}
                      >
                        {cell.getDate()}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {/* Time picker */}
            {withTime ? (
              <View style={styles.timeSection}>
                <Text style={[styles.timeLabel, { color: colors.mutedForeground }]}>
                  TIME
                </Text>
                <View style={styles.timeRow}>
                  <TimeScroller
                    values={HOURS}
                    selected={hour12}
                    format={(v) => `${v}`}
                    onSelect={(v) => commitTime(v, curMinute, period)}
                  />
                  <Text style={[styles.colon, { color: colors.foreground }]}>:</Text>
                  <TimeScroller
                    values={MINUTES}
                    selected={curMinute}
                    format={(v) => pad2(v)}
                    onSelect={(v) => commitTime(hour12, v, period)}
                  />
                  <View style={styles.periodWrap}>
                    {(["AM", "PM"] as const).map((p) => {
                      const active = period === p;
                      return (
                        <Pressable
                          key={p}
                          onPress={() => commitTime(hour12, curMinute, p)}
                          style={[
                            styles.periodBtn,
                            {
                              backgroundColor: active ? colors.primary : colors.muted,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.periodText,
                              { color: active ? "#FFFFFF" : colors.foreground },
                            ]}
                          >
                            {p}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
            ) : null}

            <Pressable
              onPress={() => setOpen(false)}
              style={[styles.doneBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function TimeScroller({
  values,
  selected,
  format,
  onSelect,
}: {
  values: number[];
  selected: number;
  format: (v: number) => string;
  onSelect: (v: number) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView
      style={styles.scroller}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingVertical: 4 }}
    >
      {values.map((v) => {
        const active = v === selected;
        return (
          <Pressable
            key={v}
            onPress={() => onSelect(v)}
            style={[
              styles.timeOption,
              active && { backgroundColor: colors.primary },
            ]}
          >
            <Text
              style={[
                styles.timeOptionText,
                { color: active ? "#FFFFFF" : colors.foreground },
              ]}
            >
              {format(v)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
  },
  fieldText: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.medium,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handleWrap: { alignItems: "center", paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  navBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  monthLabel: { fontSize: 17, fontFamily: FONT.bold },
  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dayInner: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  dayText: { fontSize: 15, fontFamily: FONT.medium },
  timeSection: { marginTop: 12 },
  timeLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  scroller: {
    height: 132,
    flex: 1,
  },
  colon: { fontSize: 22, fontFamily: FONT.bold },
  timeOption: {
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
    marginVertical: 1,
  },
  timeOptionText: { fontSize: 16, fontFamily: FONT.semibold },
  periodWrap: { gap: 8, marginLeft: 4 },
  periodBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  periodText: { fontSize: 14, fontFamily: FONT.bold },
  doneBtn: {
    marginTop: 16,
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  doneText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
