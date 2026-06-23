// Developer Performance Dashboard — DEV BUILDS ONLY.
// Shows per-stage timings and threshold violations for every scan.
// Not reachable in production builds (no nav item exists outside __DEV__).
import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import React, { useSyncExternalStore } from "react";
import {
  Alert,
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
import {
  clearScanMetrics,
  getScanMetrics,
  PERF_THRESHOLDS,
  subscribe,
  type ScanMetric,
} from "@/lib/scan-perf";

// ---------------------------------------------------------------------------
// Store hook
// ---------------------------------------------------------------------------
function useScanMetrics(): readonly ScanMetric[] {
  return useSyncExternalStore(subscribe, getScanMetrics, getScanMetrics);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusColor(value: number, threshold: number, colors: ReturnType<typeof useColors>): string {
  const ratio = value / threshold;
  if (ratio >= 1.0) return colors.destructive;
  if (ratio >= 0.75) return "#F59E0B";
  return "#22C55E";
}

// ---------------------------------------------------------------------------
// Stage row
// ---------------------------------------------------------------------------
function StageRow({
  label,
  value,
  threshold,
  colors,
  note,
}: {
  label: string;
  value: number | null;
  threshold: number;
  colors: ReturnType<typeof useColors>;
  note?: string;
}) {
  const isNA = value == null;
  const color = isNA ? colors.mutedForeground : statusColor(value, threshold, colors);
  return (
    <View style={[rowStyles.wrap, { borderBottomColor: colors.border }]}>
      <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={rowStyles.right}>
        {note ? (
          <Text style={[rowStyles.note, { color: colors.mutedForeground }]}>{note}</Text>
        ) : null}
        <Text style={[rowStyles.value, { color }]}>{isNA ? "N/A" : fmt(value)}</Text>
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: {
    fontSize: 13,
    fontFamily: FONT.medium,
    flex: 1,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  note: {
    fontSize: 11,
    fontFamily: FONT.regular,
    fontStyle: "italic",
  },
  value: {
    fontSize: 13,
    fontFamily: FONT.semibold,
    minWidth: 56,
    textAlign: "right",
  },
});

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------
function MetricCard({
  metric,
  colors,
  isLatest,
}: {
  metric: ScanMetric;
  colors: ReturnType<typeof useColors>;
  isLatest: boolean;
}) {
  const hasWarnings = metric.warnings.length > 0;
  return (
    <View
      style={[
        cardStyles.card,
        {
          backgroundColor: colors.card,
          borderColor: hasWarnings ? colors.destructive : isLatest ? colors.primary : colors.border,
          borderWidth: isLatest || hasWarnings ? 1.5 : StyleSheet.hairlineWidth,
          borderRadius: colors.radius + 2,
        },
      ]}
    >
      {/* Header */}
      <View style={cardStyles.header}>
        <View style={cardStyles.headerLeft}>
          <Text style={[cardStyles.time, { color: colors.foreground }]}>{fmtTime(metric.ts)}</Text>
          <View style={[cardStyles.pill, { backgroundColor: colors.primary + "22" }]}>
            <Text style={[cardStyles.pillText, { color: colors.primary }]}>
              {metric.mode} · {metric.source}
            </Text>
          </View>
        </View>
        <View style={cardStyles.headerRight}>
          <Text style={[cardStyles.totalLabel, { color: colors.mutedForeground }]}>Total</Text>
          <Text
            style={[
              cardStyles.totalValue,
              { color: statusColor(metric.totalMs, PERF_THRESHOLDS.totalMs, colors) },
            ]}
          >
            {fmt(metric.totalMs)}
          </Text>
        </View>
      </View>

      {/* Image info */}
      <View style={[cardStyles.imgRow, { borderColor: colors.border }]}>
        <Text style={[cardStyles.imgText, { color: colors.mutedForeground }]}>
          Captured: {metric.captureW > 0 ? `${metric.captureW}×${metric.captureH}` : "—"}
          {"  ·  "}
          Uploaded: {metric.uploadW > 0 ? `${metric.uploadW}px` : "—"}
          {"  ·  "}
          Payload: {metric.payloadKb}KB
          {metric.confidence != null ? `  ·  Conf: ${(metric.confidence * 100).toFixed(0)}%` : ""}
        </Text>
      </View>

      {/* Stage breakdown */}
      <View style={cardStyles.stages}>
        <StageRow
          label="Camera Capture"
          value={metric.captureRawMs}
          threshold={PERF_THRESHOLDS.captureRawMs}
          colors={colors}
        />
        <StageRow
          label="Image Processing"
          value={metric.processMs}
          threshold={PERF_THRESHOLDS.processMs}
          colors={colors}
        />
        <StageRow
          label="Upload + OCR"
          value={metric.uploadAndOcrMs}
          threshold={PERF_THRESHOLDS.uploadAndOcrMs}
          colors={colors}
          note="(incl. upload)"
        />
        <StageRow
          label="Contact Creation"
          value={metric.contactMs}
          threshold={PERF_THRESHOLDS.contactMs}
          colors={colors}
          note={metric.contactMs == null ? "(saved in review)" : undefined}
        />
      </View>

      {/* Warnings */}
      {hasWarnings ? (
        <View style={[cardStyles.warnBox, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "40" }]}>
          {metric.warnings.map((w, i) => (
            <View key={i} style={cardStyles.warnRow}>
              <Feather name="alert-triangle" size={12} color={colors.destructive} />
              <Text style={[cardStyles.warnText, { color: colors.destructive }]}>{w}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={[cardStyles.okBox, { backgroundColor: "#22C55E15" }]}>
          <Feather name="check-circle" size={12} color="#22C55E" />
          <Text style={[cardStyles.okText, { color: "#22C55E" }]}>All stages within thresholds</Text>
        </View>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: { marginBottom: 14, padding: 14, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  headerLeft: { flex: 1, gap: 4 },
  headerRight: { alignItems: "flex-end" },
  time: { fontSize: 14, fontFamily: FONT.semibold },
  pill: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99 },
  pillText: { fontSize: 11, fontFamily: FONT.semibold, textTransform: "uppercase", letterSpacing: 0.4 },
  totalLabel: { fontSize: 11, fontFamily: FONT.regular },
  totalValue: { fontSize: 20, fontFamily: FONT.bold },
  imgRow: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 6, marginBottom: 8 },
  imgText: { fontSize: 11.5, fontFamily: FONT.regular },
  stages: { gap: 0 },
  warnBox: { marginTop: 10, borderWidth: 1, borderRadius: 8, padding: 8, gap: 5 },
  warnRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  warnText: { fontSize: 12, fontFamily: FONT.medium, flex: 1 },
  okBox: { marginTop: 10, borderRadius: 8, padding: 8, flexDirection: "row", alignItems: "center", gap: 6 },
  okText: { fontSize: 12, fontFamily: FONT.medium },
});

// ---------------------------------------------------------------------------
// Threshold legend
// ---------------------------------------------------------------------------
function ThresholdLegend({ colors }: { colors: ReturnType<typeof useColors> }) {
  const rows = [
    { label: "Camera Capture",  ms: PERF_THRESHOLDS.captureRawMs },
    { label: "Image Processing", ms: PERF_THRESHOLDS.processMs },
    { label: "Upload + OCR",    ms: PERF_THRESHOLDS.uploadAndOcrMs },
    { label: "Contact Creation", ms: PERF_THRESHOLDS.contactMs },
    { label: "Total",           ms: PERF_THRESHOLDS.totalMs },
  ];
  return (
    <View style={[legendStyles.card, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 }]}>
      <Text style={[legendStyles.title, { color: colors.foreground }]}>Thresholds</Text>
      <Text style={[legendStyles.sub, { color: colors.mutedForeground }]}>
        🟢 &lt;75%  🟡 75–99%  🔴 ≥100%
      </Text>
      {rows.map((r) => (
        <View key={r.label} style={[legendStyles.row, { borderBottomColor: colors.border }]}>
          <Text style={[legendStyles.lbl, { color: colors.mutedForeground }]}>{r.label}</Text>
          <Text style={[legendStyles.val, { color: colors.foreground }]}>{fmt(r.ms)}</Text>
        </View>
      ))}
    </View>
  );
}

const legendStyles = StyleSheet.create({
  card: { padding: 14, marginBottom: 20, borderWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 13, fontFamily: FONT.semibold, marginBottom: 2 },
  sub: { fontSize: 11.5, fontFamily: FONT.regular, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth },
  lbl: { fontSize: 12.5, fontFamily: FONT.regular },
  val: { fontSize: 12.5, fontFamily: FONT.semibold },
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function DevPerfScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const metrics = useScanMetrics();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  if (!__DEV__) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <Text style={{ color: colors.mutedForeground, fontFamily: FONT.regular }}>
          Available in development builds only.
        </Text>
      </View>
    );
  }

  function onClear() {
    Alert.alert("Clear metrics", "Remove all recorded scan metrics?", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: clearScanMetrics },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View
        style={[
          screenStyles.header,
          {
            paddingTop: topPad + 12,
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={12} style={screenStyles.backBtn}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[screenStyles.title, { color: colors.foreground }]}>Dev Performance</Text>
        <Pressable onPress={onClear} hitSlop={12} style={screenStyles.clearBtn} disabled={metrics.length === 0}>
          <Text style={[screenStyles.clearText, { color: metrics.length === 0 ? colors.mutedForeground : colors.destructive }]}>
            Clear
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: insets.bottom + 32,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Threshold legend */}
        <ThresholdLegend colors={colors} />

        {/* Empty state */}
        {metrics.length === 0 ? (
          <View style={screenStyles.empty}>
            <Feather name="activity" size={36} color={colors.mutedForeground} />
            <Text style={[screenStyles.emptyTitle, { color: colors.foreground }]}>No scans recorded yet</Text>
            <Text style={[screenStyles.emptySub, { color: colors.mutedForeground }]}>
              Capture a business card and come back here to see the pipeline timings.
            </Text>
          </View>
        ) : (
          <>
            <Text style={[screenStyles.sectionLabel, { color: colors.mutedForeground }]}>
              RECENT SCANS ({metrics.length}/{20})
            </Text>
            {metrics.map((m, i) => (
              <MetricCard key={m.id} metric={m} colors={colors} isLatest={i === 0} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const screenStyles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4, marginRight: 8 },
  title: { flex: 1, fontSize: 18, fontFamily: FONT.bold },
  clearBtn: { padding: 4 },
  clearText: { fontSize: 14, fontFamily: FONT.semibold },
  empty: { alignItems: "center", gap: 10, paddingTop: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 17, fontFamily: FONT.semibold, textAlign: "center" },
  emptySub: { fontSize: 13.5, fontFamily: FONT.regular, textAlign: "center", lineHeight: 20 },
  sectionLabel: { fontSize: 11.5, fontFamily: FONT.semibold, letterSpacing: 0.6, marginBottom: 12 },
});
