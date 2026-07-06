import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getGetAiWorkflowBottlenecksQueryKey,
  getGetAiWorkflowHealthQueryKey,
  getGetAiWorkflowSlaRisksQueryKey,
  useGetAiWorkflowBottlenecks,
  useGetAiWorkflowHealth,
  useGetAiWorkflowSlaRisks,
  useSimulateAiWorkflowScenario,
  type WorkflowBottleneck,
  type WorkflowSimulateResponse,
  type WorkflowSlaRisk,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

const LEVEL_COLOR: Record<string, string> = {
  critical: "#e11d48",
  high: "#d97706",
  medium: "#0284c7",
  low: "#64748b",
};

const GRADE_COLOR: Record<string, string> = {
  excellent: "#059669",
  good: "#0284c7",
  fair: "#d97706",
  poor: "#e11d48",
};

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function WorkflowScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const healthQuery = useGetAiWorkflowHealth(undefined, {
    query: { queryKey: getGetAiWorkflowHealthQueryKey() },
  });
  const risksQuery = useGetAiWorkflowSlaRisks(undefined, {
    query: { queryKey: getGetAiWorkflowSlaRisksQueryKey() },
  });
  const bottlenecksQuery = useGetAiWorkflowBottlenecks(undefined, {
    query: { queryKey: getGetAiWorkflowBottlenecksQueryKey() },
  });

  const health = healthQuery.data;
  const risks = risksQuery.data;
  const bottlenecks = bottlenecksQuery.data;

  const refreshing =
    healthQuery.isRefetching || risksQuery.isRefetching || bottlenecksQuery.isRefetching;
  const onRefresh = () => {
    void healthQuery.refetch();
    void risksQuery.refetch();
    void bottlenecksQuery.refetch();
  };

  // --- Simulation ---
  const [leadId, setLeadId] = useState("");
  const [scenario, setScenario] = useState<"follow_up" | "reassign" | "delay">("follow_up");
  const [delayDays, setDelayDays] = useState("3");
  const [candidateUserId, setCandidateUserId] = useState<number | null>(null);
  const [simResult, setSimResult] = useState<WorkflowSimulateResponse | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const simulate = useSimulateAiWorkflowScenario();

  const runSimulation = () => {
    const id = parseInt(leadId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      setSimError(t("workflowManager.invalidLeadId"));
      return;
    }
    const body: { leadId: number; scenario: string; delayDays?: number; candidateUserId?: number } = {
      leadId: id,
      scenario,
    };
    if (scenario === "delay") body.delayDays = parseInt(delayDays, 10) || 1;
    if (scenario === "reassign") {
      if (!candidateUserId) {
        setSimError(t("workflowManager.chooseOwner"));
        return;
      }
      body.candidateUserId = candidateUserId;
    }
    setSimError(null);
    simulate.mutate(
      { data: body },
      {
        onSuccess: (data) => setSimResult(data as WorkflowSimulateResponse),
        onError: () => {
          setSimResult(null);
          setSimError(t("workflowManager.simError"));
        },
      },
    );
  };

  const levelLabel = (lvl: string) => t(`workflowManager.levels.${lvl}`, { defaultValue: humanize(lvl) });

  const Card = ({ children }: { children: React.ReactNode }) => (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>
  );

  const StatTile = ({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) => (
    <View style={[styles.tile, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Text style={[styles.tileValue, { color: tone ?? colors.foreground }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: colors.mutedForeground, textAlign }]}>{label}</Text>
    </View>
  );

  const renderRisk = (r: WorkflowSlaRisk) => (
    <View key={`${r.entityType}-${r.entityId}-${r.category}`} style={[styles.row, { borderTopColor: colors.border }]}>
      <View style={[styles.levelPill, { backgroundColor: (LEVEL_COLOR[r.riskLevel] ?? LEVEL_COLOR.low) + "22" }]}>
        <Text style={[styles.levelPillText, { color: LEVEL_COLOR[r.riskLevel] ?? LEVEL_COLOR.low }]}>
          {levelLabel(r.riskLevel)}
        </Text>
      </View>
      <View style={styles.flex1}>
        <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>{r.title}</Text>
        <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>{r.detail}</Text>
        {r.recommendedAction ? (
          <Text style={[styles.rowAction, { color: colors.primary, textAlign }]}>→ {r.recommendedAction}</Text>
        ) : null}
      </View>
      {r.ageDays != null ? (
        <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
          {t("workflowManager.ageDays", { days: r.ageDays })}
        </Text>
      ) : null}
    </View>
  );

  const renderBottleneck = (b: WorkflowBottleneck, i: number) => (
    <View key={`${b.type}-${i}`} style={[styles.row, { borderTopColor: colors.border }]}>
      <View style={[styles.levelPill, { backgroundColor: (LEVEL_COLOR[b.severity] ?? LEVEL_COLOR.low) + "22" }]}>
        <Text style={[styles.levelPillText, { color: LEVEL_COLOR[b.severity] ?? LEVEL_COLOR.low }]}>
          {levelLabel(b.severity)}
        </Text>
      </View>
      <View style={styles.flex1}>
        <Text style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>{b.title}</Text>
        <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>{b.detail}</Text>
        {b.recommendedAction ? (
          <Text style={[styles.rowAction, { color: colors.primary, textAlign }]}>→ {b.recommendedAction}</Text>
        ) : null}
      </View>
      <Text style={[styles.rowMeta, { color: colors.foreground, fontFamily: FONT.semibold }]}>{b.metric}</Text>
    </View>
  );

  const scenarios: Array<"follow_up" | "reassign" | "delay"> = ["follow_up", "reassign", "delay"];
  const scenarioLabel = (s: string) =>
    s === "follow_up"
      ? t("workflowManager.simFollowUp")
      : s === "reassign"
        ? t("workflowManager.simReassign")
        : t("workflowManager.simDelay");

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
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("workflowManager.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {t("workflowManager.subtitle")}
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
          {t("workflowManager.disclaimer")}
        </Text>

        {/* Operational Health */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="activity" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("workflowManager.healthTitle")}</Text>
            {health ? (
              <Text style={[styles.cardScope, { color: colors.mutedForeground }]}>· {health.scope.name}</Text>
            ) : null}
          </View>
          {healthQuery.isLoading || !health ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>
              {t("workflowManager.loading")}
            </Text>
          ) : (
            <>
              <View style={styles.tileGrid}>
                <StatTile
                  label={`${t("workflowManager.healthScore")} · ${t(`workflowManager.grades.${health.grade}`, { defaultValue: humanize(health.grade) })}`}
                  value={health.healthScore}
                  tone={GRADE_COLOR[health.grade]}
                />
                <StatTile label={t("workflowManager.slaCompliance")} value={`${health.slaCompliance}%`} />
                <StatTile
                  label={t("workflowManager.atRiskItems")}
                  value={health.totals.atRiskItems ?? 0}
                  tone="#e11d48"
                />
                <StatTile label={t("workflowManager.trackedItems")} value={health.totals.trackedItems ?? 0} />
              </View>

              {health.recommendedActions.length > 0 ? (
                <View style={[styles.actionsBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "33" }]}>
                  <Text style={[styles.actionsHead, { color: colors.primary, textAlign }]}>
                    {t("workflowManager.recommendedActions")}
                  </Text>
                  {health.recommendedActions.map((a, i) => (
                    <Text key={i} style={[styles.actionItem, { color: colors.foreground, textAlign }]}>
                      • {a}
                    </Text>
                  ))}
                </View>
              ) : null}

              {health.workload.length > 0 ? (
                <View style={styles.workloadBox}>
                  <Text style={[styles.subHead, { color: colors.mutedForeground, textAlign }]}>
                    {t("workflowManager.workload")}
                  </Text>
                  {health.workload.map((w) => (
                    <View key={w.userId} style={styles.workloadRow}>
                      <Text style={[styles.workloadName, { color: colors.foreground, textAlign }]}>{w.name}</Text>
                      <Text style={[styles.workloadMeta, { color: colors.mutedForeground }]}>
                        {t("workflowManager.workloadDetail", { open: w.openLeads, overdue: w.overdueItems })}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </Card>

        {/* SLA Risk Alerts */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="alert-triangle" size={15} color="#d97706" />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("workflowManager.risksTitle")}</Text>
            {risks ? <Text style={[styles.cardScope, { color: colors.mutedForeground }]}>· {risks.total}</Text> : null}
          </View>
          {risksQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>
              {t("workflowManager.loading")}
            </Text>
          ) : !risks || risks.risks.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>
              {t("workflowManager.noRisks")}
            </Text>
          ) : (
            risks.risks.slice(0, 25).map(renderRisk)
          )}
        </Card>

        {/* Bottlenecks */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="shield" size={15} color="#e11d48" />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              {t("workflowManager.bottlenecksTitle")}
            </Text>
          </View>
          {bottlenecksQuery.isLoading ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>
              {t("workflowManager.loading")}
            </Text>
          ) : !bottlenecks || bottlenecks.bottlenecks.length === 0 ? (
            <Text style={[styles.loading, { color: colors.mutedForeground, textAlign }]}>
              {t("workflowManager.noBottlenecks")}
            </Text>
          ) : (
            bottlenecks.bottlenecks.map(renderBottleneck)
          )}
        </Card>

        {/* Scenario Simulation */}
        <Card>
          <View style={styles.cardHead}>
            <Feather name="trending-up" size={15} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{t("workflowManager.simTitle")}</Text>
          </View>
          <Text style={[styles.rowDetail, { color: colors.mutedForeground, textAlign }]}>
            {t("workflowManager.simSubtitle")}
          </Text>

          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("workflowManager.leadId")}
          </Text>
          <TextInput
            value={leadId}
            onChangeText={setLeadId}
            keyboardType="number-pad"
            placeholder="1"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background, textAlign }]}
          />

          <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
            {t("workflowManager.scenario")}
          </Text>
          <View style={[styles.segment, { backgroundColor: colors.muted, flexDirection: isRTL ? "row-reverse" : "row" }]}>
            {scenarios.map((s) => {
              const active = scenario === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setScenario(s)}
                  style={[styles.segmentBtn, active && { backgroundColor: colors.card }]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? colors.foreground : colors.mutedForeground },
                    ]}
                    numberOfLines={1}
                  >
                    {scenarioLabel(s)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {scenario === "delay" ? (
            <>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
                {t("workflowManager.delayDays")}
              </Text>
              <TextInput
                value={delayDays}
                onChangeText={setDelayDays}
                keyboardType="number-pad"
                style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background, textAlign }]}
              />
            </>
          ) : null}

          {scenario === "reassign" ? (
            <>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
                {t("workflowManager.reassignTo")}
              </Text>
              {!health || health.workload.length === 0 ? (
                <Text style={[styles.actionItem, { color: colors.mutedForeground, textAlign }]}>
                  {t("workflowManager.noOwners")}
                </Text>
              ) : (
                <View style={styles.candidateWrap}>
                  {health.workload.map((w) => {
                    const active = candidateUserId === w.userId;
                    return (
                      <Pressable
                        key={w.userId}
                        onPress={() => setCandidateUserId(w.userId)}
                        style={[
                          styles.candidateChip,
                          { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary : colors.background },
                        ]}
                      >
                        <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontFamily: FONT.medium, fontSize: 13 }}>
                          {w.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </>
          ) : null}

          <Pressable
            onPress={runSimulation}
            disabled={simulate.isPending}
            style={[styles.simBtn, { backgroundColor: colors.primary, opacity: simulate.isPending ? 0.6 : 1 }]}
          >
            {simulate.isPending ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Feather name="play" size={14} color={colors.primaryForeground} />
            )}
            <Text style={[styles.simBtnText, { color: colors.primaryForeground }]}>
              {simulate.isPending ? t("workflowManager.simulating") : t("workflowManager.simulate")}
            </Text>
          </Pressable>

          {simError ? <Text style={[styles.errorText, { textAlign }]}>{simError}</Text> : null}

          {simResult ? (
            <View style={[styles.simResult, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <View style={styles.simGrid}>
                <View style={styles.flex1}>
                  <Text style={[styles.tileLabel, { color: colors.mutedForeground, textAlign }]}>
                    {t("workflowManager.baseline")}
                  </Text>
                  <Text style={[styles.simValue, { color: colors.foreground }]}>
                    {simResult.baseline.winProbability}%
                  </Text>
                  <Text style={[styles.rowMeta, { color: LEVEL_COLOR[simResult.baseline.riskLevel] ?? colors.mutedForeground }]}>
                    {t("workflowManager.riskSuffix", { level: levelLabel(simResult.baseline.riskLevel) })}
                  </Text>
                </View>
                <View style={styles.flex1}>
                  <Text style={[styles.tileLabel, { color: colors.mutedForeground, textAlign }]}>
                    {t("workflowManager.predicted")}
                  </Text>
                  <Text style={[styles.simValue, { color: colors.primary }]}>
                    {simResult.predicted.winProbability}%
                    <Text style={{ color: simResult.deltas.winProbability >= 0 ? "#059669" : "#e11d48" }}>
                      {"  "}
                      {simResult.deltas.winProbability >= 0 ? "+" : ""}
                      {simResult.deltas.winProbability}
                    </Text>
                  </Text>
                  <Text style={[styles.rowMeta, { color: LEVEL_COLOR[simResult.predicted.riskLevel] ?? colors.mutedForeground }]}>
                    {t("workflowManager.riskSuffix", { level: levelLabel(simResult.predicted.riskLevel) })}
                  </Text>
                </View>
              </View>
              <Text style={[styles.rowDetail, { color: colors.foreground, textAlign }]}>{simResult.explanation}</Text>
              {simResult.assumptions.length > 0 ? (
                <View>
                  <Text style={[styles.subHead, { color: colors.mutedForeground, textAlign }]}>
                    {t("workflowManager.assumptions")}
                  </Text>
                  {simResult.assumptions.map((a, i) => (
                    <Text key={i} style={[styles.actionItem, { color: colors.mutedForeground, textAlign }]}>
                      • {a}
                    </Text>
                  ))}
                </View>
              ) : null}
              <Text style={[styles.rowMeta, { color: colors.mutedForeground, textAlign }]}>
                {t("workflowManager.estConfidence", { value: simResult.confidence })}
              </Text>
            </View>
          ) : null}
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
  tile: { flexGrow: 1, minWidth: "45%", borderWidth: 1, borderRadius: 12, padding: 12 },
  tileValue: { fontSize: 22, fontFamily: FONT.bold },
  tileLabel: { fontSize: 10, fontFamily: FONT.medium, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 4 },
  actionsBox: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  actionsHead: { fontSize: 12, fontFamily: FONT.semibold, marginBottom: 2 },
  actionItem: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  workloadBox: { gap: 6 },
  candidateWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  candidateChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  subHead: { fontSize: 11, fontFamily: FONT.semibold, letterSpacing: 0.5, textTransform: "uppercase" },
  workloadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  workloadName: { fontSize: 14, fontFamily: FONT.medium },
  workloadMeta: { fontSize: 13, fontFamily: FONT.regular },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderTopWidth: 1 },
  levelPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  levelPillText: { fontSize: 10, fontFamily: FONT.semibold, textTransform: "uppercase" },
  rowTitle: { fontSize: 14, fontFamily: FONT.semibold },
  rowDetail: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular, marginTop: 1 },
  rowAction: { fontSize: 13, fontFamily: FONT.medium, marginTop: 2 },
  rowMeta: { fontSize: 12, fontFamily: FONT.regular },
  flex1: { flex: 1 },
  fieldLabel: { fontSize: 12, fontFamily: FONT.medium, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: FONT.regular },
  segment: { borderRadius: 12, padding: 3, gap: 3 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center" },
  segmentText: { fontSize: 12, fontFamily: FONT.semibold },
  simBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, paddingVertical: 12, marginTop: 6 },
  simBtnText: { fontSize: 14, fontFamily: FONT.semibold },
  errorText: { fontSize: 13, fontFamily: FONT.regular, color: "#e11d48", marginTop: 4 },
  simResult: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10, marginTop: 6 },
  simGrid: { flexDirection: "row", gap: 12 },
  simValue: { fontSize: 20, fontFamily: FONT.bold, marginTop: 2 },
});
