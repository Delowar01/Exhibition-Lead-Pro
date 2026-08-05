import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import React from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";

import { Feather } from "@/components/icons";
import { useGetUnreadCount, getGetUnreadCountQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

// ─── iOS-only modules ────────────────────────────────────────────────────────
//
// expo-glass-effect, expo-router/unstable-native-tabs, and expo-symbols are
// iOS-only native modules. Importing them at the top level causes a FATAL
// JS bundle evaluation error on Android — the native module binding is absent,
// which kills the app before any screen renders (crash immediately after splash
// screen). They are loaded lazily via inline require() inside platform-guarded
// code so the Android JS bundle never evaluates their native bindings.
//
// Metro performs dead-code elimination on Platform.OS comparisons, so the
// require() calls on the iOS branch are excluded from the Android bundle.
//
// ─────────────────────────────────────────────────────────────────────────────

function isLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isLiquidGlassAvailable } = require("expo-glass-effect") as typeof import("expo-glass-effect");
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

// IMPORTANT: iOS 26 uses NativeTabs for native tabs with liquid glass support.
// NativeTabs intentionally does NOT use custom design tokens — liquid glass is
// a system-level appearance provided by iOS and cannot be overridden. Custom
// brand colors are applied only on the ClassicTabLayout path.
// The inline require() inside this component is only ever executed on iOS 26+
// (when isLiquidGlass() returns true), so Android never loads the module.
function NativeTabLayout() {
  const { t } = useLocale();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NativeTabs, Icon, Label } = require(
    "expo-router/unstable-native-tabs",
  ) as typeof import("expo-router/unstable-native-tabs");

  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>{t("nav.home")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="capture">
        <Icon sf={{ default: "viewfinder", selected: "viewfinder" }} />
        <Label>{t("nav.scan")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="contacts">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
        <Label>{t("nav.contacts")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="notifications">
        <Icon sf={{ default: "bell", selected: "bell.fill" }} />
        <Label>{t("nav.notifications")}</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <Icon sf={{ default: "ellipsis", selected: "ellipsis" }} />
        <Label>{t("nav.more")}</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const { t } = useLocale();
  const { user } = useAuth();
  const { data: unreadData } = useGetUnreadCount({
    query: {
      queryKey: getGetUnreadCountQueryKey(),
      enabled: !!user,
      refetchInterval: 60000,
    },
  });
  const unreadCount = unreadData?.count ?? 0;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  function icon(
    sf: string,
    feather: keyof typeof Feather.glyphMap,
    color: string,
  ) {
    if (isIOS) {
      // expo-symbols is iOS-only; require it lazily so Android never loads it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SymbolView } = require("expo-symbols") as typeof import("expo-symbols");
      return <SymbolView name={sf as never} tintColor={color} size={24} />;
    }
    return <Feather name={feather} size={22} color={color} />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        // Device round #1: labels must never clip/ellipsize on narrow Android
        // widths (360dp → ~72dp per tab; "Notifications" is the long pole).
        // Slightly smaller font + zero item padding + no font scaling keeps
        // every label on one full line across 360/390/412dp.
        tabBarLabelStyle: { fontFamily: "Inter_500Medium", fontSize: 10 },
        tabBarAllowFontScaling: false,
        tabBarItemStyle: { paddingHorizontal: 0 },
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("nav.home"),
          tabBarIcon: ({ color }) => icon("house", "home", color),
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: t("nav.scan"),
          tabBarIcon: ({ color }) => icon("viewfinder", "maximize", color),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: t("nav.contacts"),
          tabBarIcon: ({ color }) => icon("person.2", "users", color),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t("nav.notifications"),
          tabBarIcon: ({ color }) => icon("bell", "bell", color),
          ...(unreadCount > 0
            ? { tabBarBadge: unreadCount > 99 ? "99+" : unreadCount }
            : {}),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t("nav.more"),
          tabBarIcon: ({ color }) => icon("ellipsis", "menu", color),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlass()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
