import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getGetAiExecutiveDashboardQueryKey,
  getListAiExecutiveReportsQueryKey,
  getListAiExecutiveSummariesQueryKey,
  useAcceptAiExecutiveSummary,
  useDismissAiExecutiveSummary,
  useGenerateAiExecutiveAlerts,
  useGenerateAiExecutiveReport,
  useGenerateAiExecutiveSummary,
  useGetAiExecutiveDashboard,
  useListAiExecutiveReports,
  useListAiExecutiveSummaries,
  type ExecutiveAlertItem,
  type ExecutiveReport,
  type ExecutiveSummary,
  type ExecutiveTeamMember,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

const RATING_COLOR: Record<string, string> = {
  excellent: "#059669",
  good: "#0284c7",
  fair: "#d97706",
  at_risk: "#e11d48",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#e11d48",
  high: "#d97706",
  warning: "#d97706",
  medium: "#0284c7",
  low: "#64748b",
  info: "#64748b",
};

const STATUS_COLOR: Record<string, string> = {
  ready: "#059669",
  pending: "#0284c7",
  processing: "#0284c7",
  failed: "#e11d48",
};

function usd(n: number | null | undefined): string {
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function summaryText(s: ExecutiveSummary): { headline: string; narrative: string; highlights: string[] } {
  const d = (s.data ?? {}) as Record<string, unknown>;
  return {
    headline: typeof d.headline === "string" ? d.headline : "Executive summary",
    narrative: typeof d.narrative === "string" ? d.narrative : "",
    highlights: Array.isArray(d.highlights) ? (d.highlights as unknown[]).map(String) : [],
  };
}

export default function ExecutiveScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign, language } = useLocale();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const dashQuery = useGetAiExecutiveDashboard(undefined, {
    query: { queryKey: getGetAiExecutiveDashboardQueryKey() },
  });
  const summariesQuery = useListAiExecutiveSummaries(undefined, {
    query: { queryKey: getListAiExecutiveSummariesQueryKey() },
  });
  const reportsQuery = useListAiExecutiveReports(undefined, {
    query: { queryKey: getListAiExecutiveReportsQueryKey(), refetchInterval: 5000 },
  });

  const genSummary = useGenerateAiExecutiveSummary();
  const acceptSummary = useAcceptAiExecutiveSummary();
  const dismissSummary = useDismissAiExecutiveSummary();
  const genAlerts = useGenerateAiExecutiveAlerts();
  const genReport = useGenerateAiExecutiveReport();

  const dash = dashQuery.data;

  const [periodType, setPeriodType] = useState<"daily" | "weekly" | "monthly" | "quarterly">("weekly");
  const [reportType, setReportType] = useState<"executive_summary" | "performance" | "forecast" | "full">(
    "executive_summary",
  );
  const [reportPeriodType, setReportPeriodType] = useState<"daily" | "weekly" | "monthly" | "quarterly">("monthly");
  const [reportFormat, setReportFormat] = useState<"pdf" | "xlsx">("pdf");

  const refreshing = dashQuery.isRefetching || summariesQuery.isRefetching || reportsQuery.isRefetching;
  const onRefresh = () => {
    void dashQuery.refetch();
    void summariesQuery.refetch();
    void reportsQuery.refetch();
  };

  const ratingLabel = (r: string) => t(`executiveManager.ratings.${r}`, { defaultValue: r.replace("_", " ") });

  const Card = ({ children }: { children: React.ReactNode }) => (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>
  );

  const HealthTile = ({ label, score, rating }: { label: string; score: number; rating: string }) => (
    <View style={[styles.tile, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Text style={[styles.tileLabel, { color: colors.mutedForeground, textAlign }]}>{label}</Text>
      <Text style={[styles.tileValue, { color: RATING_COLOR[rating] ?? colors.foreground }]}>{score}</Text>
      <Text style={[styles.tileRating, { color: RATING_COLOR[rating] ?? colors.mutedForeground, textAlign }]}>
        {ratingLabel(rating)}
      </Text>
    </View>
  );

  const KpiTile = ({ label, value }: { label: string; value: string }) => (
    <View style={[styles.tile, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Text style={[styles.kpiValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: colors.mutedForeground, textAlign }]}>{label}</Text>
    </View>
  );

  const renderAlert = (a: ExecutiveAlertItem, i: number) => (
    <View key={`${a.alertType}-${i}`} style={[styles.row, { borderTopColor: colors.border }]}>
      <View style={[styles.levelPill, { backgroundColor: (SEVERITY_COLOR[a.severity] ?? SEVERITY_COLOR.info) + "22" }]}>
        <Text style={[styles.levelPillText, { color: SEVERITY_COLOR[a.severity] ?? SEVERITY_COLOR.info }]}>
          {a.severity}
        </Text>
      </View>
      <View style={styles.flex1}>
        <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>{a.title}</Text>
        <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>{a.detail}</Text>
        {a.recommendation ? (
          <Text style={[styles.rowAction, { color: colors.primary, textAlign }]}>→ {a.recommendation}</Text>
        ) : null}
      </View>
      <Text style={[styles.rowConf, { color: colors.mutedForeground }]}>
        {t("executiveManager.confidence", { value: a.confidence })}
      </Text>
    </View>
  );

  const renderTeam = (m: ExecutiveTeamMember) => (
    <View key={m.userId} style={[styles.row, { borderTopColor: colors.border, alignItems: "center" }]}>
      <View style={styles.flex1}>
        <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>{m.name}</Text>
        <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>
          {t("executiveManager.teamDetail", { scans: m.scans, leads: m.leads, won: m.won })}
        </Text>
        {m.smallSample ? (
          <Text style={[styles.rowConf, { color: colors.mutedForeground, textAlign }]}>
            {t("executiveManager.smallSample")}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: isRTL ? "flex-start" : "flex-end" }}>
        <Text style={[styles.tileValue, { color: colors.foreground, fontSize: 18 }]}>{m.overall}</Text>
        <Text style={[styles.rowConf, { color: colors.mutedForeground }]}>{t("executiveManager.overall")}</Text>
      </View>
    </View>
  );

  const Segmented = <T extends string>({
    value,
    options,
    onChange,
    labelFor,
  }: {
    value: T;
    options: readonly T[];
    onChange: (v: T) => void;
    labelFor: (v: T) => string;
  }) => (
    <View style={[styles.segment, { backgroundColor: colors.muted, flexDirection: isRTL ? "row-reverse" : "row" }]}>
      {options.map((o) => {
        const active = value === o;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={[styles.segmentBtn, active && { backgroundColor: colors.card }]}>
            <Text
              numberOfLines={1}
              style={[styles.segmentText, { color: active ? colors.foreground : colors.mutedForeground }]}
            >
              {labelFor(o)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name={isRTL ? "chevron-right" : "chevron-left"} size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("executiveManager.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {t("executiveManager.subtitle")}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: insets.bottom + 40,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <Text style={[styles.disclaimer, { color: colors.mutedForeground, textAlign }]}>
          {t("executiveManager.disclaimer")}
        </Text>

        {/* Business Health */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="activity" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.healthTitle")}</Text>
            {dash ? <Text style={[styles.cardScope, { color: colors.mutedForeground }]}>· {dash.scope.name}</Text> : null}
          </View>
          {dashQuery.isLoading || !dash ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.loading")}</Text>
          ) : (
            <View style={styles.tileGrid}>
              <HealthTile label={t("executiveManager.business")} score={dash.health.business.score} rating={dash.health.business.rating} />
              <HealthTile label={t("executiveManager.sales")} score={dash.health.sales.score} rating={dash.health.sales.rating} />
              <HealthTile label={t("executiveManager.pipeline")} score={dash.health.pipeline.score} rating={dash.health.pipeline.rating} />
            </View>
          )}
        </Card>

        {/* KPIs */}
        {dash ? (
          <Card>
            <View style={styles.cardHead}>
              <Feather name="bar-chart-2" size={15} color={colors.primary} />
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.kpisTitle")}</Text>
            </View>
            <View style={styles.tileGrid}>
              <KpiTile label={t("executiveManager.conversion")} value={`${num((dash.kpis as Record<string, unknown>).conversionRate)}%`} />
              <KpiTile label={t("executiveManager.newLeads")} value={num((dash.kpis as Record<string, unknown>).newLeads).toLocaleString()} />
              <KpiTile label={t("executiveManager.wins")} value={num((dash.kpis as Record<string, unknown>).wonCount).toLocaleString()} />
              <KpiTile label={t("executiveManager.wonValue")} value={usd(num((dash.kpis as Record<string, unknown>).wonValue))} />
              <KpiTile label={t("executiveManager.openPipeline")} value={usd(num((dash.kpis as Record<string, unknown>).openPipelineValue))} />
              <KpiTile label={t("executiveManager.headcount")} value={num((dash.kpis as Record<string, unknown>).headcount).toLocaleString()} />
            </View>
          </Card>
        ) : null}

        {/* Forecast */}
        {dash ? (
          <Card>
            <View style={styles.cardHead}>
              <Feather name="trending-up" size={15} color={colors.primary} />
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.forecastTitle")}</Text>
            </View>
            <Text style={[styles.forecastValue, { color: colors.foreground, textAlign }]}>{usd(dash.forecast.expected)}</Text>
            <View style={styles.metaRow}>
              <Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>{t("executiveManager.range")}</Text>
              <Text style={[styles.rowTitle, { color: colors.foreground }]}>
                {usd(dash.forecast.low)} – {usd(dash.forecast.high)}
              </Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>{t("executiveManager.confidenceLabel")}</Text>
              <Text style={[styles.rowTitle, { color: colors.foreground }]}>{dash.forecast.confidence}%</Text>
            </View>
            {dash.forecast.assumptions.length > 0 ? (
              <View style={{ marginTop: 4 }}>
                {dash.forecast.assumptions.map((a, i) => (
                  <Text key={i} style={[styles.actionItem, { color: colors.mutedForeground, textAlign }]}>• {a}</Text>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* Executive Alerts */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="alert-triangle" size={15} color="#d97706" />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.alertsTitle")}</Text>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={() => genAlerts.mutate({ data: {} })}
              disabled={genAlerts.isPending}
              style={[styles.smallBtn, { borderColor: colors.border }]}
            >
              {genAlerts.isPending ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Feather name="refresh-cw" size={13} color={colors.primary} />
              )}
              <Text style={[styles.smallBtnText, { color: colors.primary }]}>{t("executiveManager.generate")}</Text>
            </Pressable>
          </View>
          {dashQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.loading")}</Text>
          ) : !dash || dash.alerts.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.noAlerts")}</Text>
          ) : (
            dash.alerts.map(renderAlert)
          )}
        </Card>

        {/* Team Performance */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="users" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.teamTitle")}</Text>
          </View>
          {dashQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.loading")}</Text>
          ) : !dash || dash.teamPerformance.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.noTeam")}</Text>
          ) : (
            dash.teamPerformance.slice(0, 12).map(renderTeam)
          )}
        </Card>

        {/* Executive Summaries */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="file-text" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.summariesTitle")}</Text>
          </View>
          <Segmented
            value={periodType}
            options={["daily", "weekly", "monthly", "quarterly"] as const}
            onChange={setPeriodType}
            labelFor={(p) => t(`executiveManager.periods.${p}`)}
          />
          <Pressable
            onPress={() => genSummary.mutate({ data: { periodType, language } })}
            disabled={genSummary.isPending}
            style={[styles.genBtn, { backgroundColor: colors.primary, opacity: genSummary.isPending ? 0.6 : 1 }]}
          >
            {genSummary.isPending ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="zap" size={14} color={colors.primaryForeground} />
            )}
            <Text style={[styles.genBtnText, { color: colors.primaryForeground }]}>
              {genSummary.isPending ? t("executiveManager.generating") : t("executiveManager.generateSummary")}
            </Text>
          </Pressable>

          {summariesQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.loading")}</Text>
          ) : !summariesQuery.data || summariesQuery.data.summaries.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.noSummaries")}</Text>
          ) : (
            summariesQuery.data.summaries.slice(0, 8).map((s) => {
              const tx = summaryText(s);
              return (
                <View key={s.id} style={[styles.summaryBox, { borderColor: colors.border, backgroundColor: colors.background }]}>
                  <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>{tx.headline}</Text>
                  <View style={[styles.tagRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                    <View style={[styles.tag, { borderColor: colors.border }]}>
                      <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{t(`executiveManager.periods.${s.periodType}`, { defaultValue: s.periodType })}</Text>
                    </View>
                    <View style={[styles.tag, { borderColor: colors.border }]}>
                      <Text style={[styles.tagText, { color: s.source === "ai" ? colors.primary : colors.mutedForeground }]}>
                        {s.source === "ai" ? t("executiveManager.aiTag") : t("executiveManager.deterministicTag")}
                      </Text>
                    </View>
                    <View style={[styles.tag, { borderColor: colors.border }]}>
                      <Text style={[styles.tagText, { color: colors.mutedForeground }]}>{t(`executiveManager.statuses.${s.status}`, { defaultValue: s.status })}</Text>
                    </View>
                  </View>
                  {tx.narrative ? (
                    <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>{tx.narrative}</Text>
                  ) : null}
                  {tx.highlights.slice(0, 4).map((h, i) => (
                    <Text key={i} style={[styles.actionItem, { color: colors.foreground, textAlign }]}>• {h}</Text>
                  ))}
                  {s.status === "suggested" ? (
                    <View style={[styles.tagRow, { flexDirection: isRTL ? "row-reverse" : "row", marginTop: 8 }]}>
                      <Pressable
                        onPress={() => acceptSummary.mutate({ id: s.id })}
                        style={[styles.actionChip, { borderColor: "#05966955", backgroundColor: "#05966915" }]}
                      >
                        <Feather name="check" size={13} color="#059669" />
                        <Text style={[styles.actionChipText, { color: "#059669" }]}>{t("executiveManager.accept")}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => dismissSummary.mutate({ id: s.id })}
                        style={[styles.actionChip, { borderColor: "#e11d4855", backgroundColor: "#e11d4815" }]}
                      >
                        <Feather name="x" size={13} color="#e11d48" />
                        <Text style={[styles.actionChipText, { color: "#e11d48" }]}>{t("executiveManager.dismiss")}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </Card>

        {/* AI Reports */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="download" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("executiveManager.reportsTitle")}</Text>
          </View>
          <Segmented
            value={reportType}
            options={["executive_summary", "performance", "forecast", "full"] as const}
            onChange={setReportType}
            labelFor={(r) => t(`executiveManager.reportTypes.${r}`)}
          />
          <Segmented
            value={reportPeriodType}
            options={["daily", "weekly", "monthly", "quarterly"] as const}
            onChange={setReportPeriodType}
            labelFor={(p) => t(`executiveManager.periods.${p}`, { defaultValue: p })}
          />
          <Segmented
            value={reportFormat}
            options={["pdf", "xlsx"] as const}
            onChange={setReportFormat}
            labelFor={(f) => (f === "pdf" ? "PDF" : "Excel")}
          />
          <Pressable
            onPress={() => genReport.mutate({ data: { reportType, periodType: reportPeriodType, format: reportFormat, language } })}
            disabled={genReport.isPending}
            style={[styles.genBtn, { backgroundColor: colors.primary, opacity: genReport.isPending ? 0.6 : 1 }]}
          >
            {genReport.isPending ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="file-text" size={14} color={colors.primaryForeground} />
            )}
            <Text style={[styles.genBtnText, { color: colors.primaryForeground }]}>
              {genReport.isPending ? t("executiveManager.queuing") : t("executiveManager.generateReport")}
            </Text>
          </Pressable>

          {reportsQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.loading")}</Text>
          ) : !reportsQuery.data || reportsQuery.data.reports.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>{t("executiveManager.noReports")}</Text>
          ) : (
            reportsQuery.data.reports.slice(0, 10).map((r: ExecutiveReport) => (
              <View key={r.id} style={[styles.row, { borderTopColor: colors.border, alignItems: "center" }]}>
                <Feather name="file" size={15} color={colors.mutedForeground} />
                <View style={styles.flex1}>
                  <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>
                    {t(`executiveManager.reportTypes.${r.reportType}`, { defaultValue: r.reportType })}
                    {r.periodType ? ` · ${t(`executiveManager.periods.${r.periodType}`, { defaultValue: r.periodType })}` : ""} · {r.format.toUpperCase()}
                  </Text>
                  <Text style={[styles.rowConf, { color: STATUS_COLOR[r.status] ?? colors.mutedForeground, textAlign }]}>
                    {t(`executiveManager.statuses.${r.status}`, { defaultValue: r.status })}
                  </Text>
                  {r.error ? <Text style={[styles.rowConf, { color: "#e11d48", textAlign }]}>{r.error}</Text> : null}
                </View>
                {r.status === "ready" && r.downloadUrl ? (
                  <Pressable
                    onPress={() => Linking.openURL(r.downloadUrl!)}
                    style={[styles.smallBtn, { borderColor: colors.border }]}
                  >
                    <Feather name="download" size={13} color={colors.primary} />
                    <Text style={[styles.smallBtnText, { color: colors.primary }]}>{t("executiveManager.download")}</Text>
                  </Pressable>
                ) : r.status !== "failed" ? (
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                ) : null}
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  heading: { fontSize: 26, fontFamily: FONT.bold },
  headingSub: { fontSize: 13, fontFamily: FONT.regular, marginTop: 4 },
  disclaimer: { fontSize: 12, fontFamily: FONT.regular, fontStyle: "italic", marginBottom: 14 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 16, fontFamily: FONT.semibold },
  cardScope: { fontSize: 12, fontFamily: FONT.regular },
  loading: { fontSize: 13, fontFamily: FONT.regular, paddingVertical: 6 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { flexGrow: 1, minWidth: "30%", borderWidth: 1, borderRadius: 12, padding: 12 },
  tileLabel: { fontSize: 10, fontFamily: FONT.medium, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 4 },
  tileValue: { fontSize: 24, fontFamily: FONT.bold },
  tileRating: { fontSize: 11, fontFamily: FONT.semibold, textTransform: "capitalize", marginTop: 2 },
  kpiValue: { fontSize: 18, fontFamily: FONT.bold },
  forecastValue: { fontSize: 28, fontFamily: FONT.bold },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  actionItem: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderTopWidth: 1 },
  levelPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  levelPillText: { fontSize: 10, fontFamily: FONT.semibold, textTransform: "uppercase" },
  rowTitle: { fontSize: 14, fontFamily: FONT.semibold },
  rowDetail: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular, marginTop: 1 },
  rowAction: { fontSize: 13, fontFamily: FONT.medium, marginTop: 2 },
  rowConf: { fontSize: 11, fontFamily: FONT.regular },
  flex1: { flex: 1 },
  segment: { borderRadius: 12, padding: 3, gap: 3 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center" },
  segmentText: { fontSize: 12, fontFamily: FONT.semibold },
  genBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    paddingVertical: 12,
  },
  genBtnText: { fontSize: 14, fontFamily: FONT.semibold },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  smallBtnText: { fontSize: 12, fontFamily: FONT.semibold },
  summaryBox: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  tagText: { fontSize: 10, fontFamily: FONT.semibold, textTransform: "capitalize" },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionChipText: { fontSize: 12, fontFamily: FONT.semibold },
});
