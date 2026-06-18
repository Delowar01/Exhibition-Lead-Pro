import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Event,
  getListEventsQueryKey,
  useCreateEvent,
  useListEvents,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { DateTimeField } from "@/components/DateTimeField";
import {
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
  PrimaryButton,
} from "@/components/ui";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";

export default function EventPickerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { activeEventId, setActiveEvent } = useSettings();

  const query = useListEvents({ limit: 100 });
  const createEvent = useCreateEvent();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [country, setCountry] = useState("");
  const [booth, setBooth] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const events = query.data?.events ?? [];

  function select(ev: Event) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setActiveEvent(ev.id, ev.name);
    router.back();
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError("Event name is required.");
      return;
    }
    setError(null);
    try {
      const ev = await createEvent.mutateAsync({
        data: {
          name: name.trim(),
          venue: venue.trim() || null,
          country: country.trim() || null,
          boothNumber: booth.trim() || null,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
          status: "active",
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListEventsQueryKey() });
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setActiveEvent(ev.id, ev.name);
      router.back();
    } catch {
      setError("Couldn't create the event. Please try again.");
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name="chevron-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.heading, { color: colors.foreground }]}>
          {creating ? "New event" : "Choose event"}
        </Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground }]}>
          {creating
            ? "Add an exhibition or trade show"
            : "Captures are tagged to the active event"}
        </Text>
      </View>

      {creating ? (
        <KeyboardAwareScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 40,
          }}
          bottomOffset={20}
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
              <Feather name="alert-circle" size={15} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
            </View>
          ) : null}

          <Field label="Event name *" value={name} onChange={setName} placeholder="GITEX Global 2026" />
          <Field label="Venue" value={venue} onChange={setVenue} placeholder="Dubai World Trade Centre" />
          <Field label="Country" value={country} onChange={setCountry} placeholder="United Arab Emirates" />
          <Field label="Booth number" value={booth} onChange={setBooth} placeholder="H7-B20" />
          <DateTimeField
            label="Start date"
            date={startDate}
            withTime={false}
            optional
            onChange={(d) => setStartDate(d)}
          />
          <DateTimeField
            label="End date"
            date={endDate}
            withTime={false}
            optional
            onChange={(d) => setEndDate(d)}
          />

          <View style={{ height: 8 }} />
          <PrimaryButton
            label="Create & select"
            icon="check"
            onPress={handleCreate}
            loading={createEvent.isPending}
          />
          <Pressable onPress={() => setCreating(false)} style={styles.cancelBtn}>
            <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
          </Pressable>
        </KeyboardAwareScrollView>
      ) : query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <KeyboardAwareScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 40,
            gap: 10,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              setCreating(true);
            }}
            style={({ pressed }) => [
              styles.createRow,
              { borderColor: colors.primary, borderRadius: colors.radius + 4, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <View style={[styles.createIcon, { backgroundColor: colors.primary }]}>
              <Feather name="plus" size={20} color="#FFFFFF" />
            </View>
            <Text style={[styles.createLabel, { color: colors.primary }]}>Create new event</Text>
          </Pressable>

          {events.length === 0 ? (
            <View style={{ paddingTop: 40 }}>
              <EmptyState
                icon="calendar"
                title="No events yet"
                subtitle="Create your first event to start capturing leads."
              />
            </View>
          ) : (
            events.map((ev) => {
              const active = ev.id === activeEventId;
              return (
                <Pressable
                  key={ev.id}
                  onPress={() => select(ev)}
                  style={({ pressed }) => [
                    styles.eventRow,
                    {
                      backgroundColor: colors.card,
                      borderColor: active ? colors.primary : colors.border,
                      borderRadius: colors.radius + 4,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View style={[styles.eventIcon, { backgroundColor: colors.accent }]}>
                    <Feather name="calendar" size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[styles.eventName, { color: colors.foreground }]}>
                      {ev.name}
                    </Text>
                    {ev.venue || ev.country ? (
                      <Text numberOfLines={1} style={[styles.eventMeta, { color: colors.mutedForeground }]}>
                        {[ev.venue, ev.country].filter(Boolean).join(" · ")}
                      </Text>
                    ) : null}
                  </View>
                  {active ? (
                    <Feather name="check-circle" size={20} color={colors.primary} />
                  ) : (
                    <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
                  )}
                </Pressable>
              );
            })
          )}
        </KeyboardAwareScrollView>
      )}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const colors = useColors();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
        {label.toUpperCase()}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        style={[
          styles.input,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius,
            color: colors.foreground,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  heading: { fontSize: 28, fontFamily: FONT.bold },
  headingSub: { fontSize: 14, fontFamily: FONT.regular, marginTop: 2 },
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  createIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  createLabel: { fontSize: 15.5, fontFamily: FONT.semibold },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
  },
  eventIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  eventName: { fontSize: 15.5, fontFamily: FONT.semibold },
  eventMeta: { fontSize: 13, fontFamily: FONT.regular, marginTop: 2 },
  fieldLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    fontSize: 15,
    fontFamily: FONT.medium,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FONT.medium },
  cancelBtn: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  cancelText: { fontSize: 15, fontFamily: FONT.medium },
});
