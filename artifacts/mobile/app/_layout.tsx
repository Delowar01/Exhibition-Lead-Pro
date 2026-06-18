import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Feather } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Font from "expo-font";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { Platform, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NotificationsManager } from "@/components/NotificationsManager";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { OfflineProvider } from "@/contexts/OfflineContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { getCachedToken } from "@/lib/auth-storage";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Wire the API client once, at module load, before any request fires.
// EXPO_PUBLIC_DOMAIN is the Replit dev domain (no protocol) in dev, and the
// deployment domain in production — both route through the shared proxy.
const apiDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (apiDomain) {
  setBaseUrl(`https://${apiDomain}`);
}
setAuthTokenGetter(() => getCachedToken());

const queryClient = new QueryClient();

// On web there is no hardware/native back gesture, so provide an explicit
// header back affordance. On native, leaving headerLeft unset preserves the
// platform's native back button + swipe gesture.
function WebHeaderBack({ canGoBack }: { canGoBack?: boolean }) {
  const router = useRouter();
  if (!canGoBack) return null;
  return (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      style={{ paddingHorizontal: 4, paddingVertical: 4 }}
    >
      <Feather name="arrow-left" size={22} />
    </Pressable>
  );
}

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const PUBLIC_ROUTES = ["login", "forgot-password"];
    const onPublicRoute = PUBLIC_ROUTES.includes(segments[0] ?? "");
    if (!isAuthenticated && !onPublicRoute) {
      router.replace("/login");
    } else if (isAuthenticated && segments[0] === "login") {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return (
    <>
      <NotificationsManager />
      <Stack
        screenOptions={{
          headerBackTitle: "Back",
          ...(Platform.OS === "web"
            ? { headerLeft: (props) => <WebHeaderBack canGoBack={props.canGoBack} /> }
            : {}),
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen
        name="scan-review"
        options={{ presentation: "modal", title: "Review details" }}
      />
      <Stack.Screen
        name="capture-camera"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="batch-review"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="event-picker"
        options={{ headerShown: false, presentation: "modal" }}
      />
      <Stack.Screen
        name="capture-qr"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      <Stack.Screen name="capture-manual" options={{ title: "Manual entry" }} />
      <Stack.Screen name="leads" options={{ headerShown: false }} />
      <Stack.Screen name="events" options={{ headerShown: false }} />
      <Stack.Screen name="meetings" options={{ headerShown: false }} />
      <Stack.Screen name="tasks" options={{ headerShown: false }} />
      <Stack.Screen name="duplicates" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="sync" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  // Load the Inter text fonts in their own batch. These resolve reliably on
  // every platform and the splash screen waits on them.
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Load the Feather icon font SEPARATELY and crash-proof. @expo/vector-icons
  // renders icons with fontFamily "feather" (lowercase). Loading it in the same
  // useFonts batch as Inter is dangerous: a single failing entry fails the whole
  // batch, which previously made Inter fall back too. Here a failure is caught so
  // text stays correct and icons simply degrade. The byte-identical LOCAL asset
  // is used (more reliably bundled by Metro than the deeply pnpm-symlinked
  // package asset behind `...Feather.font`).
  const [iconsReady, setIconsReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    Font.loadAsync({ feather: require("../assets/fonts/feather.ttf") })
      .catch(() => {
        // Icon font failed to register at runtime; the app still renders with
        // text fonts intact. Native builds also embed it via the expo-font plugin.
      })
      .finally(() => {
        if (mounted) setIconsReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Gate render on the text fonts only — never block (or crash) the app on the
  // icon font. `iconsReady` is referenced so the tree re-renders once the icon
  // font finishes loading, swapping tofu/placeholder glyphs for real icons.
  void iconsReady;
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <OfflineProvider>
                <GestureHandlerRootView>
                  <KeyboardProvider>
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </OfflineProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
