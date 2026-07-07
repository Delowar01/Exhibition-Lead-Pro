import { Feather } from "@/components/icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getGetAiAssistantConversationQueryKey,
  getGetAiAssistantSuggestionsQueryKey,
  getListAiAssistantConversationsQueryKey,
  useCreateAiAssistantConversation,
  useDeleteAiAssistantConversation,
  useGetAiAssistantConversation,
  useGetAiAssistantSuggestions,
  useListAiAssistantConversations,
  useSendAiAssistantMessage,
  type AssistantConversation,
  type AssistantMessage,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { FONT } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

export default function AssistantScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, textAlign, language } = useLocale();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const assistantPerms = (user?.permissions?.ai_assistant as string[] | undefined) ?? [];
  const canUse =
    user?.role === "primary_admin" || assistantPerms.includes("use");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const convsQuery = useListAiAssistantConversations(undefined, {
    query: { queryKey: getListAiAssistantConversationsQueryKey(undefined) },
  });
  const conversations = convsQuery.data?.conversations ?? [];

  const detailQuery = useGetAiAssistantConversation(selectedId ?? 0, {
    query: {
      queryKey: getGetAiAssistantConversationQueryKey(selectedId ?? 0),
      enabled: selectedId != null,
    },
  });
  const messages = (detailQuery.data?.messages ?? []) as AssistantMessage[];

  const suggestionsQuery = useGetAiAssistantSuggestions(undefined, {
    query: { queryKey: getGetAiAssistantSuggestionsQueryKey(undefined) },
  });
  const prompts = suggestionsQuery.data?.prompts ?? [];

  const createMutation = useCreateAiAssistantConversation();
  const deleteMutation = useDeleteAiAssistantConversation();
  const sendMutation = useSendAiAssistantMessage();

  useEffect(() => {
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    return () => clearTimeout(id);
  }, [messages.length, pendingText]);

  const sendTo = (conversationId: number, content: string) => {
    setPendingText(content);
    sendMutation.mutate(
      { id: conversationId, data: { content, language: language === "ar" ? "ar" : "en" } },
      {
        onSuccess: () => {
          setPendingText(null);
          void queryClient.invalidateQueries({
            queryKey: getGetAiAssistantConversationQueryKey(conversationId),
          });
          void queryClient.invalidateQueries({
            queryKey: getListAiAssistantConversationsQueryKey(undefined),
          });
        },
        onError: () => setPendingText(null),
      },
    );
  };

  const handleSend = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sendMutation.isPending || createMutation.isPending) return;
    setInput("");
    if (selectedId != null) {
      sendTo(selectedId, content);
      return;
    }
    createMutation.mutate(
      { data: {} },
      {
        onSuccess: (conv: AssistantConversation) => {
          setSelectedId(conv.id);
          sendTo(conv.id, content);
        },
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          if (selectedId === id) setSelectedId(null);
          void queryClient.invalidateQueries({
            queryKey: getListAiAssistantConversationsQueryKey(undefined),
          });
        },
      },
    );
  };

  const renderMessage = (m: AssistantMessage) => {
    const isUser = m.role === "user";
    return (
      <View
        key={m.id}
        style={[
          styles.bubble,
          isUser
            ? [styles.bubbleUser, { backgroundColor: colors.primary }]
            : [styles.bubbleAssistant, { backgroundColor: colors.card, borderColor: colors.border }],
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            { color: isUser ? "#fff" : colors.foreground, textAlign },
          ]}
        >
          {m.content}
        </Text>
        {!isUser && (
          <View style={styles.metaRow}>
            <Feather
              name={m.source === "ai" ? "cpu" : "shield"}
              size={11}
              color={colors.mutedForeground}
            />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              {m.source === "ai"
                ? `${t("assistant.aiSource")}${m.model ? ` · ${m.model}` : ""}`
                : t("assistant.deterministicSource")}
              {typeof m.confidence === "number" ? ` · ${m.confidence}%` : ""}
            </Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.foreground, textAlign }]}>
            {t("assistant.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, textAlign }]}>
            {t("assistant.disclaimer")}
          </Text>
        </View>
        <Pressable
          onPress={() => setShowHistory((v) => !v)}
          style={[styles.iconBtn, { borderColor: colors.border }]}
          accessibilityLabel={t("assistant.history")}
        >
          <Feather name="clock" size={18} color={colors.foreground} />
        </Pressable>
        <Pressable
          onPress={() => {
            setSelectedId(null);
            setShowHistory(false);
          }}
          style={[styles.iconBtn, { borderColor: colors.border }]}
          accessibilityLabel={t("assistant.newConversation")}
        >
          <Feather name="plus" size={18} color={colors.foreground} />
        </Pressable>
      </View>

      {showHistory ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, padding: 16 }} keyboardShouldPersistTaps="handled">
          {convsQuery.isLoading ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : conversations.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.mutedForeground, textAlign }]}>
              {t("assistant.noConversations")}
            </Text>
          ) : (
            conversations.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  setSelectedId(c.id);
                  setShowHistory(false);
                }}
                style={[styles.convRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.convTitle, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                    {c.title}
                  </Text>
                  <Text style={[styles.metaText, { color: colors.mutedForeground, textAlign }]}>
                    {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ""}
                  </Text>
                </View>
                <Pressable onPress={() => handleDelete(c.id)} hitSlop={8}>
                  <Feather name="trash-2" size={16} color={colors.mutedForeground} />
                </Pressable>
              </Pressable>
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, padding: 16, gap: 10 }}
          keyboardShouldPersistTaps="handled"
        >
          {selectedId == null && !pendingText ? (
            <View style={styles.emptyWrap}>
              <Feather name="message-circle" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground, textAlign: "center" }]}>
                {t("assistant.emptyTitle")}
              </Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground, textAlign: "center" }]}>
                {t("assistant.emptyDesc")}
              </Text>
              <View style={styles.chipsWrap}>
                {prompts.map((p, i) => (
                  <Pressable
                    key={i}
                    onPress={() => canUse && handleSend(p.prompt)}
                    style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <Text style={[styles.chipText, { color: colors.foreground }]}>{p.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            <>
              {detailQuery.isLoading && selectedId != null ? (
                <ActivityIndicator style={{ marginTop: 24 }} />
              ) : null}
              {messages.map(renderMessage)}
              {pendingText ? (
                <>
                  <View style={[styles.bubble, styles.bubbleUser, { backgroundColor: colors.primary }]}>
                    <Text style={[styles.bubbleText, { color: "#fff", textAlign }]}>{pendingText}</Text>
                  </View>
                  <View
                    style={[styles.bubble, styles.bubbleAssistant, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 8 }]}
                  >
                    <ActivityIndicator size="small" />
                    <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
                      {t("assistant.thinking")}
                    </Text>
                  </View>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      )}

      <View
        style={[
          styles.inputRow,
          { borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 10) },
        ]}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={canUse ? t("assistant.placeholder") : t("assistant.readOnly")}
          placeholderTextColor={colors.mutedForeground}
          editable={canUse && !sendMutation.isPending && !createMutation.isPending}
          multiline
          style={[
            styles.input,
            { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border, textAlign },
          ]}
          onSubmitEditing={() => handleSend()}
        />
        <Pressable
          onPress={() => handleSend()}
          disabled={!canUse || !input.trim() || sendMutation.isPending || createMutation.isPending}
          style={[
            styles.sendBtn,
            {
              backgroundColor:
                !canUse || !input.trim() || sendMutation.isPending ? colors.muted : colors.primary,
            },
          ]}
          accessibilityLabel={t("assistant.send")}
        >
          {sendMutation.isPending || createMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Feather name="send" size={18} color="#fff" />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontFamily: FONT.bold },
  subtitle: { fontSize: 11, fontFamily: FONT.regular, marginTop: 2 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  bubble: { maxWidth: "85%", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleUser: { alignSelf: "flex-end" },
  bubbleAssistant: { alignSelf: "flex-start", borderWidth: 1 },
  bubbleText: { fontSize: 14, fontFamily: FONT.regular, lineHeight: 20 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  metaText: { fontSize: 10, fontFamily: FONT.regular },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 22, fontFamily: FONT.bold, marginTop: 12 },
  emptyText: { fontSize: 15, fontFamily: FONT.regular, lineHeight: 22, opacity: 0.8 },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 24 },
  chip: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  chipText: { fontSize: 13, fontFamily: FONT.medium },
  convRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  convTitle: { fontSize: 14, fontFamily: FONT.medium },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxHeight: 110,
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
